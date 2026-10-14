import { STAGE_LABELS, STAGE_RANK } from './unit-flow.service.js';

/**
 * Master-wise tracking: for one master and the tailors who work under them, every order that has an article assigned to
 * the team, with how many of its articles the team has picked up, how many are still waiting to be picked up, and exactly
 * which ones. Pure: the controller loads the rows, this only reads them.
 *
 * An article is "picked up" by the master's team once it has left `to_assign` (the master received it). Articles of the same
 * order that belong to ANOTHER master are not part of this team's order.
 */

const ARTICLE_STATE_LABELS = {
  pending: 'Waiting to be picked up',
  with_master: 'Received by the master',
  with_tailor: 'Received by the tailor',
  completed: 'Completed by the team',
};

/** Where an article is, from the team's point of view. */
export const teamState = (card) => {
  const rank = STAGE_RANK[card.stage];
  if (rank <= STAGE_RANK.to_assign) return 'pending';
  if (rank === STAGE_RANK.cutting) return 'with_master';
  if (rank === STAGE_RANK.stitching) return 'with_tailor';
  return 'completed';
};

/**
 * @param {{ master: object, tailors: object[], cards: object[], units: object[], orders: object[], receipts: object[], onlyMemberId?: string | null }} input
 *   `cards` are ALL cards of the orders involved; `onlyMemberId` limits the view to one team member (a tailor sees themselves).
 */
export const buildMasterTracking = ({ master, tailors, cards, units, orders, receipts, onlyMemberId = null }) => {
  const team = [master, ...tailors];
  const teamIds = new Set(team.map((m) => m.id));
  const tailorIds = new Set(tailors.map((t) => t.id));
  const nameOf = new Map(team.map((m) => [m.id, m.name]));
  const unitOf = new Map(units.map((u) => [u.id, u]));
  const lastReceipt = new Map(); // `${unit}|${stage}` -> receipt (oldest first, the last one wins)
  for (const r of receipts) lastReceipt.set(`${r.unit_id}|${r.stage}`, r);

  /** The team's share of an order: assigned to the master or a tailor of the team, or not assigned to anyone yet. */
  const inTeam = (c) => c.master_id === master.id || (c.tailor_id && tailorIds.has(c.tailor_id)) || (!c.master_id && !c.tailor_id);
  const assignedToTeam = (c) => c.master_id === master.id || (c.tailor_id && tailorIds.has(c.tailor_id));

  const memberStats = new Map(team.map((m) => [m.id, { received: 0, pending: 0, completed: 0 }]));
  const bump = (id, key) => {
    const s = memberStats.get(id);
    if (s) s[key] += 1;
  };

  const rows = [];
  for (const order of orders) {
    const orderCards = cards.filter((c) => c.order_id === order.id);
    if (!orderCards.some(assignedToTeam)) continue; // not this team's order
    const scope = orderCards.filter(inTeam).sort((a, b) => (unitOf.get(a.unit_id)?.line_no ?? 0) - (unitOf.get(b.unit_id)?.line_no ?? 0));

    const articles = scope.map((c) => {
      const u = unitOf.get(c.unit_id) || {};
      const state = teamState(c);
      const cut = lastReceipt.get(`${c.unit_id}|cutting`);
      const stitch = lastReceipt.get(`${c.unit_id}|stitching`);
      // the person holding it now: the tailor once it is stitching or beyond, otherwise the master
      const holderId = state === 'with_tailor' || (state === 'completed' && c.tailor_id) ? c.tailor_id : c.master_id;

      // per-member numbers (only articles assigned to a member count for that member)
      if (c.master_id === master.id) {
        if (state === 'pending') bump(master.id, 'pending');
        else {
          bump(master.id, 'received');
          if (STAGE_RANK[c.stage] > STAGE_RANK.cutting) bump(master.id, 'completed'); // the master's part (cutting) is done
        }
      }
      if (c.tailor_id && tailorIds.has(c.tailor_id)) {
        const rank = STAGE_RANK[c.stage];
        if (rank < STAGE_RANK.stitching) bump(c.tailor_id, 'pending'); // assigned to the tailor, not picked up yet
        else {
          bump(c.tailor_id, 'received');
          if (rank > STAGE_RANK.stitching) bump(c.tailor_id, 'completed');
        }
      }

      return {
        unit_id: c.unit_id, code: u.code ?? null, title: u.unit_title ?? c.unit_title ?? 'Article', line_no: u.line_no ?? 0,
        stage: c.stage, stage_label: STAGE_LABELS[c.stage] ?? c.stage,
        state, state_label: ARTICLE_STATE_LABELS[state],
        master: c.master_id ? nameOf.get(c.master_id) ?? null : null,
        tailor: c.tailor_id ? nameOf.get(c.tailor_id) ?? null : null,
        holder_id: holderId ?? null,
        tailor_id: c.tailor_id ?? null,
        assigned_to_team: !!assignedToTeam(c),
        received_by: state === 'pending' ? null : (state === 'with_master' ? cut?.user_name : state === 'with_tailor' ? stitch?.user_name ?? cut?.user_name : stitch?.user_name ?? cut?.user_name) ?? null,
        received_at: state === 'pending' ? null : (state === 'with_master' ? cut?.received_at : stitch?.received_at ?? cut?.received_at) ?? null,
      };
    });

    // a tailor sees only what is assigned to them
    // (and for them "picked up" means received for stitching: the articles waiting at the master are still to come)
    const visible = onlyMemberId
      ? articles
          .filter((a) => a.tailor_id === onlyMemberId)
          .map((a) => (STAGE_RANK[a.stage] < STAGE_RANK.stitching ? { ...a, state: 'pending', state_label: ARTICLE_STATE_LABELS.pending } : a))
      : articles;
    if (!visible.length) continue;
    const pending = visible.filter((a) => a.state === 'pending').length;
    const received = visible.length - pending;
    const members = [...new Set(visible.flatMap((a) => [a.master, a.tailor]).filter(Boolean))];
    rows.push({
      order_id: order.id, reference: order.reference, customer_name: order.customer_name ?? null, brand: order.brand ?? null,
      due_date: order.due_date ?? null, status: order.status,
      total: visible.length, received, remaining: pending, completed: visible.filter((a) => a.state === 'completed').length,
      members,
      remaining_text: pending === 0 ? 'All articles picked up' : `${pending} article${pending === 1 ? '' : 's'} remaining to pick up`,
      articles: visible,
    });
  }
  rows.sort((a, b) => (b.remaining > 0) - (a.remaining > 0) || String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')) || a.reference.localeCompare(b.reference));

  const visibleTeam = onlyMemberId ? team.filter((m) => m.id === onlyMemberId) : team;
  const summary = visibleTeam.map((m) => ({
    id: m.id, name: m.name, role: m.role, is_master: m.id === master.id, daily_capacity: m.daily_capacity ?? null,
    ...memberStats.get(m.id),
  }));
  const totals = {
    orders: rows.length,
    articles: rows.reduce((n, o) => n + o.total, 0),
    received: rows.reduce((n, o) => n + o.received, 0),
    remaining: rows.reduce((n, o) => n + o.remaining, 0),
    completed: rows.reduce((n, o) => n + o.completed, 0),
  };
  return { master: { id: master.id, name: master.name }, members: summary, orders: rows, totals };
};
