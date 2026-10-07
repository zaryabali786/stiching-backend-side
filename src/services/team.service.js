import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';

/**
 * Current workload per team member.
 * Masters carry the cards in "cutting"; tailors carry the cards in "stitching".
 * load = assigned work / daily capacity (as defined in the project brief).
 */
export const getTeamWithLoad = async ({ includeInactive = false, partnerId } = {}) => {
  // `partnerId` limits everything to one partner's people and tickets; leave it out only for an admin who wants all
  let q = supabaseAdmin.from('team_members').select('*').order('name');
  if (!includeInactive) q = q.eq('is_active', true);
  if (partnerId !== undefined) q = q.eq('partner_id', partnerId);
  const members = unwrap(await q);

  let cardsQuery = supabaseAdmin.from('job_cards').select('master_id, tailor_id, stage').in('stage', ['cutting', 'stitching', 'qc']);
  if (partnerId !== undefined) cardsQuery = cardsQuery.eq('partner_id', partnerId);
  const cards = unwrap(await cardsQuery);

  const cuttingByMaster = {};
  const stitchingByTailor = {};
  for (const c of cards) {
    if (c.stage === 'cutting' && c.master_id) cuttingByMaster[c.master_id] = (cuttingByMaster[c.master_id] || 0) + 1;
    if (c.stage === 'stitching' && c.tailor_id) stitchingByTailor[c.tailor_id] = (stitchingByTailor[c.tailor_id] || 0) + 1;
  }

  // the login (if any) of each person: email, whether it is switched on, and the type/permissions it holds
  const userIds = members.map((m) => m.user_id).filter(Boolean);
  const logins = new Map();
  if (userIds.length) {
    for (const p of unwrap(await supabaseAdmin.from('profiles').select('id, email, is_active, staff_type, permissions, must_change_password').in('id', userIds))) logins.set(p.id, p);
  }

  const withLoad = members.map((m) => {
    const assigned = m.role === 'master' ? cuttingByMaster[m.id] || 0 : stitchingByTailor[m.id] || 0;
    const capacity = Math.max(1, m.daily_capacity || 1);
    const loadPct = Math.round((assigned / capacity) * 100);
    return {
      ...m,
      login: m.user_id ? logins.get(m.user_id) ?? null : null,
      assigned,
      load_pct: loadPct,
      load_status: assigned === 0 ? 'free' : loadPct >= 100 ? 'full' : 'busy',
    };
  });

  const masters = withLoad
    .filter((m) => m.role === 'master')
    .map((master) => {
      const tailors = withLoad.filter((t) => t.role === 'tailor' && t.master_id === master.id);
      const teamAssigned = master.assigned + tailors.reduce((a, t) => a + t.assigned, 0);
      const teamCapacity = Math.max(1, master.daily_capacity + tailors.reduce((a, t) => a + (t.daily_capacity || 0), 0));
      return {
        ...master,
        tailors,
        team_assigned: teamAssigned,
        team_capacity: teamCapacity,
        team_load_pct: Math.round((teamAssigned / teamCapacity) * 100),
      };
    });

  const unassignedTailors = withLoad.filter((t) => t.role === 'tailor' && !masters.some((m) => m.id === t.master_id));
  return { masters, unassignedTailors, members: withLoad };
};

const leastLoaded = (list) =>
  list
    .filter((m) => m.is_active !== false)
    .sort((a, b) => a.assigned / Math.max(1, a.daily_capacity) - b.assigned / Math.max(1, b.daily_capacity) || a.name.localeCompare(b.name))[0] || null;

/**
 * Suggest the least-loaded master, and the least-loaded tailor (preferably in that master's team).
 */
export const suggestAssignees = async (masterId = null, partnerId) => {
  const { masters, members } = await getTeamWithLoad({ partnerId });
  const master = masterId ? masters.find((m) => m.id === masterId) || null : leastLoaded(masters);
  const teamTailors = master ? master.tailors : [];
  const tailor = leastLoaded(teamTailors.length ? teamTailors : members.filter((m) => m.role === 'tailor'));
  return {
    master: master ? { id: master.id, name: master.name, assigned: master.assigned, load_pct: master.load_pct } : null,
    tailor: tailor ? { id: tailor.id, name: tailor.name, assigned: tailor.assigned, load_pct: tailor.load_pct } : null,
  };
};
