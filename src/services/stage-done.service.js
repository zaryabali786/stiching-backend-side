import { supabaseAdmin } from '../config/supabase.js';

/**
 * "This stage is finished" marks, saved by Scan to complete. One platform_settings row per job card (`stage_done:<card id>`),
 * so no table changes are needed: { stage, at, by, by_name }.
 * A mark only counts while the card is still in that stage and the mark is newer than the day the card entered the stage,
 * so a card that goes back (for example failed quality check) is never "done" by an old mark.
 */
const key = (cardId) => `stage_done:${cardId}`;
const ENTERED = { cutting: 'cutting_at', stitching: 'stitching_at', qc: 'qc_at', pressing: 'pressing_at', packed: 'packed_at' };

const validFor = (card, mark) => {
  if (!mark || mark.stage !== card.stage) return null;
  const entered = card[ENTERED[card.stage]];
  if (entered && mark.at && new Date(mark.at) < new Date(entered)) return null;
  return mark;
};

/** Put `stage_done` ({ stage, at, by_name } or null) on every card. Returns the same cards. */
export const attachStageDone = async (cards) => {
  const list = (cards || []).filter(Boolean);
  if (!list.length) return cards;
  const { data } = await supabaseAdmin.from('platform_settings').select('key, value').in('key', list.map((c) => key(c.id)));
  const byKey = new Map((data || []).map((r) => [r.key, r.value]));
  for (const c of list) c.stage_done = validFor(c, byKey.get(key(c.id)));
  return cards;
};

export const markStageDone = async (card, { userId, name }) => {
  const value = { stage: card.stage, at: new Date().toISOString(), by: userId ?? null, by_name: name ?? null };
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: key(card.id), value, updated_by: userId ?? null, updated_at: value.at });
  if (error) throw error;
  return value;
};

export const clearStageDone = async (cardId) => {
  await supabaseAdmin.from('platform_settings').delete().eq('key', key(cardId));
};
