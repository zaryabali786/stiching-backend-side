import { supabaseAdmin } from '../config/supabase.js';

/**
 * "Client approval required after QC" (stored as 'qc_client_approval' in platform_settings), switched by the admin in Settings.
 *   ON  (default, also when nothing is saved): the customer must approve the QC photos before an article moves on to Pressing.
 *   OFF: QC sends the article straight to Pressing; no photos are sent and nothing waits for the customer.
 * Turning it OFF never touches an approval that is already waiting or already given: those records stay as they are.
 */
export const loadQcApproval = async () => {
  const { data, error } = await supabaseAdmin.from('platform_settings').select('value').eq('key', 'qc_client_approval').maybeSingle();
  if (error) return { required: true };
  return { required: data?.value?.required !== false };
};

/** The one question the workflow asks: must the customer approve the QC photos? (a failed read keeps the safe default: yes) */
export const isQcApprovalRequired = async () => (await loadQcApproval()).required;

export const saveQcApproval = async (required, userId) => {
  const { error } = await supabaseAdmin
    .from('platform_settings')
    .upsert({ key: 'qc_client_approval', value: { required: required === true }, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
  return loadQcApproval();
};
