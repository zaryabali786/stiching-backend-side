/**
 * Article-level workflow rules, kept free of database calls so they can be tested on their own.
 *
 *   production:   to_assign -> cutting (master) -> stitching (tailor) -> qc (QA) -> pressing -> packed (packing)
 *   customer:     received -> pending approval -> approved | rejected -> (return) -> corrected -> pending approval ...
 *
 * An ORDER is only the parent. Every article (order_unit) has its own state; the order status is derived from them.
 */

export const STAGES = ['to_assign', 'cutting', 'stitching', 'qc', 'pressing', 'packed'];
export const STAGE_LABELS = { to_assign: 'To assign', cutting: 'Cutting', stitching: 'Stitching', qc: 'Quality check', pressing: 'Pressing', packed: 'Packed' };
export const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s, i]));

/** The stage a scan moves an article into, and the stage it has to come from. */
export const PREVIOUS_STAGE = { cutting: 'to_assign', stitching: 'cutting', qc: 'stitching', pressing: 'qc', packed: 'pressing' };

/** What each kind of staff member receives (scans). `permission` is the module permission they need. */
export const SCAN_ROLES = {
  master: { stage: 'cutting', permission: 'production.scan', label: 'Master' },
  tailor: { stage: 'stitching', permission: 'production.scan', label: 'Tailor' },
  qa: { stage: 'qc', permission: 'quality.scan', label: 'Quality check' },
  pressing: { stage: 'pressing', permission: 'production.scan', label: 'Pressing' },
  packing: { stage: 'packed', permission: 'production.scan', label: 'Packing' },
};
export const STAFF_TYPES = ['master', 'tailor', 'qa', 'pressing', 'packing', 'staff'];

/** The stage after each stage: an owner or admin (no staff type) receives an article into the stage that comes next. */
export const NEXT_STAGE = { to_assign: 'cutting', cutting: 'stitching', stitching: 'qc', qc: 'pressing', pressing: 'packed' };

/**
 * Which production stage does this person receive articles for? Nobody picks it: it comes from their own records.
 *   1. their staff type (master, tailor, QA, pressing, packing)
 *   2. their team record on the production board (a master or tailor)
 *   3. only the quality permission, no production permission: quality check
 *   4. an owner or admin who supervises: no fixed stage, each scan receives the article into the stage that follows its current one
 * @returns {{ ok: true, role: string, stage: string | null, permission: string | null, supervisor: boolean } | { ok: false, message: string }}
 */
export const resolveScanRole = ({ staffType, memberRole, qualityOnly, isSupervisor }) => {
  const typed = (key) => ({ ok: true, role: key, stage: SCAN_ROLES[key].stage, permission: SCAN_ROLES[key].permission, supervisor: false });
  if (staffType && SCAN_ROLES[staffType]) return typed(staffType);
  if (memberRole && SCAN_ROLES[memberRole]) return typed(memberRole);
  if (qualityOnly) return typed('qa');
  if (isSupervisor) return { ok: true, role: 'supervisor', stage: null, permission: null, supervisor: true };
  return { ok: false, message: 'Your account is not set up to receive articles. Ask the admin to give you a production role (master, tailor, quality check, pressing or packing).' };
};

/**
 * What the customer's approval of the QC photos means for an article, by the admin's setting `approvalRequired`:
 *   true       the article may leave Quality check for Pressing only once the customer approved its photos
 *   false      approval is not asked: nothing waits for the customer (a request already sent is left as it is)
 *   undefined  the older rule: only a request that is still waiting blocks the article
 * @returns {string | null} why the article is held back, or null
 */
export const approvalHold = (card, approvalRequired, title = 'This article') => {
  if (approvalRequired === false) return null;
  if (card.approval_status === 'pending') return `${title} is waiting for the customer to approve its photos.`;
  if (approvalRequired === true && card.stage === 'qc' && card.approval_status !== 'approved') {
    return card.approval_status === 'changes_requested'
      ? `${title}: the customer asked for changes to the photos. Send new photos for approval.`
      : `${title} needs the customer's approval of its QC photos first. Send the photos from Quality check.`;
  }
  return null;
};

/**
 * May this person mark the article's CURRENT stage as finished (Scan to complete)?
 * Master: cutting, tailor: stitching, QA: quality check, pressing: pressing. Packed is the last stage: nothing comes after it.
 * Owners / admins ('supervisor') may complete any stage. Master / tailor only their own articles.
 * @returns {{ ok: true, assign: object } | { ok: false, code: 'duplicate' | 'invalid_transition' | 'blocked' | 'forbidden', message: string }}
 */
export const checkComplete = ({ role, card, member, title = 'This article', approvalRequired }) => {
  const stage = card.stage;
  if (stage === 'to_assign') return { ok: false, code: 'invalid_transition', message: `${title} has not been received by a master yet. Use Scan to receive first.` };
  if (stage === 'packed') return { ok: false, code: 'invalid_transition', message: `${title} is already packed. Packed is the last stage.` };
  const mine = role === 'supervisor' ? stage : SCAN_ROLES[role]?.stage;
  if (mine !== stage) return { ok: false, code: 'forbidden', message: `${title} is in ${STAGE_LABELS[stage]}. Only the ${STAGE_LABELS[stage]} person can complete it.` };
  if (card.stage_done) return { ok: false, code: 'duplicate', message: `${title} is already completed in ${STAGE_LABELS[stage]}. Waiting for ${STAGE_LABELS[NEXT_STAGE[stage]]} to receive it.` };
  if (approvalRequired === false ? false : card.approval_status === 'pending') return { ok: false, code: 'blocked', message: `${title} is waiting for the customer to approve its photos.` };
  if (stage === 'qc' && !card.qc_passed) return { ok: false, code: 'blocked', message: `${title} has not passed quality check yet.` };
  const assign = {};
  if (role === 'master' || role === 'tailor') {
    const column = role === 'master' ? 'master_id' : 'tailor_id';
    if (card[column] && (!member || card[column] !== member.id)) return { ok: false, code: 'forbidden', message: `${title} is assigned to another ${role}.` };
    if (!card[column] && member) assign[column] = member.id;
  }
  return { ok: true, assign };
};

/** The permission a stage needs (used for owners / admins, whose stage follows the article). */
export const permissionForStage = (stage) => Object.values(SCAN_ROLES).find((r) => r.stage === stage)?.permission ?? null;

/**
 * May this scan move the article's job card into `stage`?
 * @param {{ role: string, stage: string, card: object, member: { id: string } | null, title?: string }} input
 * @returns {{ ok: true, assign: object } | { ok: false, code: 'duplicate' | 'invalid_transition' | 'blocked' | 'forbidden', message: string }}
 */
export const checkReceive = ({ role, stage, card, member, title = 'This article', approvalRequired }) => {
  if (card.stage === stage) {
    return { ok: false, code: 'duplicate', message: `${title} was already received for ${STAGE_LABELS[stage]}.` };
  }
  const from = PREVIOUS_STAGE[stage];
  if (card.stage !== from) {
    const where = STAGE_LABELS[card.stage] || card.stage;
    return { ok: false, code: 'invalid_transition', message: `${title} is in ${where} now. It can only be received for ${STAGE_LABELS[stage]} after ${STAGE_LABELS[from]}.` };
  }
  const held = approvalHold(card, approvalRequired, title);
  if (held && (card.approval_status === 'pending' || card.qc_passed)) return { ok: false, code: 'blocked', message: held };
  if (stage === 'pressing' && !card.qc_passed) {
    return { ok: false, code: 'blocked', message: `${title} has not passed quality check yet.` };
  }
  if (held) return { ok: false, code: 'blocked', message: held };
  // the stage before has to be finished (Scan to complete) before the next person may take the article; owners / admins may override
  if (from !== 'to_assign' && role !== 'supervisor' && !card.stage_done) {
    return { ok: false, code: 'blocked', message: `${title} is not completed in ${STAGE_LABELS[from]} yet. The ${STAGE_LABELS[from]} person must scan it to complete first.` };
  }

  const assign = {};
  if (role === 'master' || role === 'tailor') {
    const column = role === 'master' ? 'master_id' : 'tailor_id';
    if (card[column]) {
      if (!member || card[column] !== member.id) {
        return { ok: false, code: 'forbidden', message: `${title} is assigned to another ${role}.` };
      }
    } else if (member) {
      assign[column] = member.id; // nobody was assigned: the person who receives it takes it
    }
  }
  return { ok: true, assign };
};

// ─────────────────────────────── order sources and returns ───────────────────────────────

/**
 * Where an order came from decides its approval workflow:
 *   website   bought on a brand's website (product links / invoice): approve, then finish articles / sizes / notes
 *   email     made from an order email in the shopping inbox: approve, then finish articles / sizes / notes
 *   customer  the customer's own parcel: approve, then straight to production (no articles step)
 */
export const ORDER_SOURCES = ['website', 'customer', 'email'];
export const SOURCE_LABELS = { website: 'Website', customer: 'Customer', email: 'Email' };

export const sourceOf = (order) => {
  if (order?.order_source && ORDER_SOURCES.includes(order.order_source)) return order.order_source;
  if (order?.import_source === 'email') return 'email';
  if (order?.import_source === 'link' || order?.import_source === 'invoice') return 'website';
  return 'customer';
};

/** Website and email orders finish their details after the parcel is approved; a customer's own order does not. */
export const needsDetails = (order) => sourceOf(order) !== 'customer';

/** Where a rejected parcel can be sent back to, by order source. A customer's own parcel only ever goes back to them. */
export const RETURN_TARGETS = { customer: ['customer'], website: ['brand', 'customer'], email: ['brand', 'customer'] };
export const RETURN_LABELS = { brand: 'the brand', customer: 'the customer' };

/** @returns {{ ok: true, target: 'brand'|'customer' } | { ok: false, message: string }} */
export const resolveReturnTarget = (source, requested) => {
  const allowed = RETURN_TARGETS[source] || RETURN_TARGETS.customer;
  if (allowed.length === 1) return { ok: true, target: allowed[0] };
  if (!requested) return { ok: false, message: 'Choose where the parcel should be returned: the brand or you.' };
  if (!allowed.includes(requested)) return { ok: false, message: 'That return destination is not available for this order.' };
  return { ok: true, target: requested };
};

// ─────────────────────────────── customer review of a received article ───────────────────────────────

/** The order-level review flag from its articles: only 'approved' when every reviewed article is approved. */
export const orderReviewFlag = (units) => {
  const reviewed = units.filter((u) => u.review_status && u.review_status !== 'none');
  if (!reviewed.length) return 'none';
  return reviewed.every((u) => u.review_status === 'approved') ? 'approved' : 'pending';
};

/**
 * Can the customer finish (submit) the order now? Every received article must have a decision; at least one is approved.
 * Rejected articles carry on separately, they do not stop the others.
 */
export const canCustomerSubmit = (units) => {
  if (units.some((u) => u.review_status === 'pending')) return { ok: false, message: 'Approve or reject each article first.' };
  if (!units.some((u) => u.review_status === 'approved')) return { ok: false, message: 'Approve at least one article to continue.' };
  return { ok: true };
};

/** Does this article still have to be reviewed / corrected before it can enter production? */
export const holdsOrderBack = (unit) => unit.review_status === 'pending' || unit.review_status === 'rejected' || (unit.return_status && unit.return_status !== 'none');

/**
 * The one word that tells where an article is, for both apps.
 *   pending_receipt · received · pending_approval · approved · rejected · return_requested · returned · issue ·
 *   in_production · completed
 */
/**
 * A problem the partner reported at receiving and the customer has not decided on yet. Only such an article offers Hold / Return;
 * an article without a reported problem offers Approve only. This is read from the stored status, never from the screen.
 */
export const hasOpenIssue = (unit) => unit?.status === 'issue' && unit?.review_status === 'pending';

export const articleState = ({ unit, card, order }) => {
  // the customer chose Hold / Return for a reported problem: it follows that path, not "issue"
  if (unit.status === 'issue' && !['held', 'requested', 'sent_back', 'returned'].includes(unit.return_status) && unit.review_status !== 'rejected') return 'issue';
  // a corrected article that came back waits for the customer like any other article
  if (unit.return_status === 'held') return unit.review_status === 'pending' ? 'pending_approval' : 'on_hold';
  if (unit.return_status === 'sent_back' || unit.return_status === 'returned') return 'returned';
  if (unit.return_status === 'requested') return 'return_requested';
  if (unit.review_status === 'rejected') return 'rejected';
  if (unit.review_status === 'pending') return 'pending_approval';
  if (unit.status !== 'received') return 'pending_receipt';
  if (card) {
    if (card.stage === 'packed' && ['paid', 'at_admin_warehouse', 'partner_dispatch', 'shipped', 'delivered'].includes(order?.status)) return 'completed';
    return 'in_production';
  }
  return unit.review_status === 'approved' ? 'approved' : 'received';
};

export const ARTICLE_STATE_LABELS = {
  pending_receipt: 'Pending receipt',
  received: 'Received',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  return_requested: 'Return requested',
  on_hold: 'On hold',
  details_completed: 'You completed the order details',
  returned: 'Returned',
  issue: 'Problem found',
  in_production: 'In production',
  completed: 'Completed',
};

/** Customer-visible lines of an article's timeline for the review / return steps. */
export const REVIEW_EVENT_LABELS = {
  review_requested: 'Ready for your review',
  review_approved: 'You approved it',
  review_rejected: 'You rejected it',
  review_held: 'You put it on hold',
  hold_received: 'Corrected article received. Please review it',
  hold_resolved: 'Hold resolved',
  return_requested: 'Return requested',
  returned: 'Sent back',
  resubmitted: 'Corrected article is back. Please review it again',
  scan_cutting: 'Received by the master',
  scan_stitching: 'Received by the tailor',
  scan_qc: 'Received for quality check',
  scan_pressing: 'Received for pressing',
  scan_packed: 'Received for packing',
};

/**
 * What the customer sees about returns for the whole order: how many articles were rejected, where they go and how far
 * along the return is. `whole_parcel` = every article was rejected.
 */
export const returnSummary = (units) => {
  const sent = units.filter((u) => u.review_status === 'rejected' || (u.return_status && u.return_status !== 'none' && u.return_status !== 'resubmitted'));
  if (!sent.length) return null;
  const targets = [...new Set(sent.map((u) => u.return_to).filter(Boolean))];
  return {
    count: sent.length,
    total: units.length,
    to: targets.length === 1 ? targets[0] : null,
    status: sent.every((u) => ['sent_back', 'returned'].includes(u.return_status)) ? 'sent_back' : sent.every((u) => u.return_status === 'held') ? 'held' : 'requested',
    whole_parcel: sent.length === units.length,
  };
};

/**
 * The return badge for the customer's order list: only articles the customer actually sent back count.
 *   requested   a return was asked for and nothing has been posted yet
 *   in_progress the partner posted it back
 *   completed   the corrected / replacement article came back
 * Returns null for orders without a return (rejected without a return request included).
 */
export const returnBadge = (units) => {
  const rows = (units || []).filter((u) => u.return_status && u.return_status !== 'none');
  if (!rows.length) return null;
  const requested = rows.filter((u) => u.return_status === 'requested');
  const sentBack = rows.filter((u) => u.return_status === 'sent_back');
  const held = rows.filter((u) => u.return_status === 'held');
  const active = requested.length ? requested : sentBack.length ? sentBack : held;
  const status = requested.length ? 'requested' : sentBack.length ? 'in_progress' : held.length ? 'on_hold' : 'completed';
  const pool = active.length ? active : rows;
  const targets = [...new Set(pool.map((u) => u.return_to).filter(Boolean))];
  // one line per distinct courier + tracking number (articles posted together share it)
  const seen = new Set();
  const shipments = [];
  for (const u of rows) {
    const courier = u.return_courier || null;
    const tracking = u.return_tracking || null;
    if (!courier && !tracking) continue;
    const key = `${courier}|${tracking}`;
    if (!seen.has(key)) { seen.add(key); shipments.push({ courier, tracking }); }
  }
  return { status, to: targets.length === 1 ? targets[0] : null, count: pool.length, total: units.length, whole_parcel: pool.length === units.length, shipments };
};

// ─────────────────────────────── order groups (main / hold / return / resolved) ───────────────────────────────

/**
 * Which group an article belongs to. One order is shown as up to four groups, derived from its articles:
 *   main      approved / in production / waiting for receipt or review
 *   hold      the customer put it on hold (stays here until the corrected article is received AND approved)
 *   return    rejected and sent back (or waiting to be sent back)
 *   resolved  a hold whose corrected article was received by the partner and approved by the customer
 */
export const articleGroup = (unit) => {
  if (unit.hold_resolved_at) return 'resolved';
  if (unit.return_status === 'held') return 'hold';
  if (unit.review_status === 'rejected' && ['requested', 'sent_back', 'returned', 'none'].includes(unit.return_status || 'none')) return 'return';
  if (unit.return_status === 'sent_back' || unit.return_status === 'returned') return 'return';
  return 'main';
};

export const GROUP_SUFFIX = { main: '', hold: '-HOLD', return: '-RETURN', resolved: '-RESOLVED' };
export const GROUP_LABELS = { main: 'Order', hold: 'On hold', return: 'Return', resolved: 'Resolved' };
export const groupReference = (reference, group) => `${reference}${GROUP_SUFFIX[group] || ''}`;

/** [{ group, reference, label, count }] for the groups that have at least one article, main first. */
export const groupSummary = (reference, units) => {
  const counts = { main: 0, hold: 0, return: 0, resolved: 0 };
  for (const u of units || []) counts[articleGroup(u)] += 1;
  return ['main', 'hold', 'return', 'resolved'].filter((g) => counts[g]).map((g) => ({ group: g, reference: groupReference(reference, g), label: GROUP_LABELS[g], count: counts[g] }));
};

// ─────────────────────────────── receiving progress per order ───────────────────────────────

/**
 * Where one article stands for the person receiving at `stage`:
 *   awaiting   it is in the stage before theirs and they may receive it now
 *   received   it was received at their stage and is still there
 *   done       it was received at their stage and has already moved on
 *   not_ready  it has not reached their stage yet, is held back (customer approval, QC), or is not released
 *   assigned   it is the right stage but assigned to someone else
 */
export const classifyForStage = ({ stage, card, unit, receipt, member, role, approvalRequired }) => {
  if (!card) return { kind: 'not_ready', reason: unit?.review_status === 'pending' ? 'Waiting for the customer to approve' : unit?.review_status === 'rejected' ? 'Rejected by the customer' : 'Not in production yet' };
  if (card.stage === stage) return { kind: 'received' };
  if (STAGE_RANK[card.stage] > STAGE_RANK[stage]) return { kind: 'done' };
  if (card.stage !== PREVIOUS_STAGE[stage]) return { kind: 'not_ready', reason: `Still in ${STAGE_LABELS[card.stage] || card.stage}` };
  if (approvalHold(card, approvalRequired)) return { kind: 'not_ready', reason: card.approval_status === 'pending' ? 'Waiting for the customer to approve the photos' : 'Waiting for the customer to approve the QC photos' };
  if (stage === 'pressing' && !card.qc_passed) return { kind: 'not_ready', reason: 'Quality check not passed yet' };
  if (PREVIOUS_STAGE[stage] !== 'to_assign' && role !== 'supervisor' && !card.stage_done) return { kind: 'not_ready', reason: `${STAGE_LABELS[card.stage]} is not completed yet` };
  if (role === 'master' || role === 'tailor') {
    const column = role === 'master' ? 'master_id' : 'tailor_id';
    if (card[column] && (!member || card[column] !== member.id)) return { kind: 'assigned', reason: `Assigned to another ${role}` };
  }
  return { kind: 'awaiting' };
};

/** Counts and the article list for one order at one stage (the numbers the receiving screen shows). */
export const progressFor = ({ order, units, cards, receipts, stage, userId, member, role, approvalRequired }) => {
  const cardOf = new Map(cards.map((c) => [c.unit_id, c]));
  const lastReceipt = new Map();
  for (const r of receipts) if (r.stage === stage) lastReceipt.set(r.unit_id, r); // oldest first, so the last one wins
  const articles = units.map((u) => {
    const card = cardOf.get(u.id) || null;
    const receipt = lastReceipt.get(u.id) || null;
    const c = classifyForStage({ stage, card, unit: u, receipt, member, role, approvalRequired });
    const received = c.kind === 'received' || c.kind === 'done';
    return {
      unit_id: u.id, code: u.code, line_no: u.line_no, title: u.unit_title,
      kind: c.kind, reason: c.reason ?? null,
      stage: card?.stage ?? null, stage_label: card ? STAGE_LABELS[card.stage] : null,
      received_by: received ? receipt?.user_name ?? null : null,
      received_role: received ? receipt?.role ?? null : null,
      received_at: received ? receipt?.received_at ?? null : null,
      mine: received && !!receipt && receipt.user_id === userId,
    };
  });
  const count = (kind) => articles.filter((a) => a.kind === kind).length;
  const received = count('received') + count('done');
  const awaiting = count('awaiting');
  const remaining = articles.length - received;
  const next = NEXT_STAGE[stage];
  return {
    order_id: order.id, reference: order.reference, customer_name: order.customer_name ?? null, customer_code: order.customer_code ?? null, brand: order.brand ?? null,
    stage, stage_label: STAGE_LABELS[stage],
    total: articles.length, received, mine: articles.filter((a) => a.mine).length, remaining, awaiting, done: count('done'),
    next_action: awaiting > 0
      ? `Scan ${awaiting} more article${awaiting === 1 ? '' : 's'} for ${STAGE_LABELS[stage]}`
      : remaining > 0
        ? 'The rest are not ready for you yet'
        : next ? `All received. Next stage: ${STAGE_LABELS[next]}` : 'All received',
    articles,
  };
};
