/**
 * Size chart measurements (inches). One list of keys the API accepts and the screens label.
 * Older keys stay valid so existing charts keep working.
 */
export const MEASUREMENT_GROUPS = {
  shirt: ['shirt_length', 'shoulder', 'bust', 'waist', 'hip', 'bottom', 'sleeve', 'cuff_opening', 'armhole'],
  trouser: ['trouser_length', 'front_rise', 'back_rise', 'waist_relaxed', 'trouser_hip', 'knee', 'thigh', 'bottom_opening'],
};
const LEGACY_KEYS = ['shalwar_gheer', 'neck_depth'];

export const MEASUREMENT_KEYS = [...MEASUREMENT_GROUPS.shirt, ...MEASUREMENT_GROUPS.trouser, ...LEGACY_KEYS];
export const NEAREST_SIZES = ['XS', 'S', 'M', 'L', 'XL'];

/** Whitelist + validate a measurements object (numbers 0-120 inches; blanks are dropped). */
export const cleanMeasurements = (m = {}, fail) => {
  const out = {};
  for (const key of MEASUREMENT_KEYS) {
    if (m?.[key] === undefined || m[key] === null || m[key] === '') continue;
    const n = Number(m[key]);
    if (Number.isNaN(n) || n < 0 || n > 120) throw fail(`${key.replace(/_/g, ' ')} must be a number of inches (0-120).`);
    out[key] = n;
  }
  return out;
};

export const cleanNearestSize = (value, fail) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const v = String(value).trim().toUpperCase();
  if (!NEAREST_SIZES.includes(v)) throw fail(`Nearest size must be one of ${NEAREST_SIZES.join(', ')}.`);
  return v;
};

/** Frozen copy of a chart stored on an order piece, so later edits to the chart never change an order in production. */
export const sizeSnapshotOf = (chart) =>
  chart
    ? {
        id: chart.id,
        name: chart.name,
        person_name: chart.person_name ?? null,
        variation: chart.variation ?? null,
        nearest_size: chart.nearest_size ?? null,
        measurements: chart.measurements ?? {},
        notes: chart.notes ?? null,
        notes_audio: chart.notes_audio ?? null,
        fit_feedback: chart.fit_feedback ?? null,
      }
    : null;

/** Put the order's own copy where screens expect `size_chart` (falls back to the live chart for older orders). */
export const withSizeSnapshot = ({ size_snapshot, ...unit }) => ({ ...unit, size_chart: size_snapshot || unit.size_chart || null });
