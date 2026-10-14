import { BadRequestError } from '../utils/error.helper.js';

/**
 * How a courier consignment (CN) is obtained. A courier with an API connection registers a provider here and the booking
 * screens call it; the UI never knows provider details. A courier without one (every courier today) is booked by the partner
 * with the courier directly, and the CN is typed in.
 *
 * A provider is { name, book({ courier, parcel }) → { cn, response } }. Nothing is registered: no courier API is connected to this
 * project, and nothing here pretends otherwise.
 */
const providers = new Map();

export const registerCourierProvider = (courierName, provider) => providers.set(String(courierName).trim().toLowerCase(), provider);

export const unregisterCourierProvider = (courierName) => providers.delete(String(courierName).trim().toLowerCase());

export const providerFor = (courierName) => providers.get(String(courierName ?? '').trim().toLowerCase()) ?? null;

export const supportsApiBooking = (courierName) => !!providerFor(courierName)?.book;

/**
 * The CN for a booking: from the courier's API when the courier has a provider (a failure there throws and nothing moves
 * forward), otherwise the CN the partner entered.
 * @returns {Promise<{ cn: string, source: 'api'|'manual', response: object|null }>}
 */
export const obtainCn = async ({ courier, manualCn, parcel, forceManual = false }) => {
  // a parcel booked outside the system (the courier's own portal or branch): the CN is typed in even when the courier has an API
  const provider = forceManual ? null : providerFor(courier.name);
  if (provider?.book) {
    let result;
    try {
      result = await provider.book({ courier, parcel });
    } catch (e) {
      const hint = e?.unknownOutcome ? ' The request may have reached the courier: check their portal before booking again, or enter the CN by hand.' : '';
      throw new BadRequestError(`${courier.name} could not book this parcel: ${e?.message || 'the courier did not accept the booking'}.${hint}`);
    }
    if (!result?.cn) throw new BadRequestError(`${courier.name} did not return a CN. Nothing was booked.`);
    return { cn: String(result.cn), source: 'api', response: result.response ?? null };
  }
  const cn = String(manualCn ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (cn.length < 4) throw new BadRequestError(`Enter the CN (consignment) number ${courier.name} gave for this parcel.`);
  return { cn, source: 'manual', response: null };
};

/** Cancel a booking that was made through the courier's API (nothing to do for a manual one). Throws if the courier did not cancel. */
export const cancelWithProvider = async ({ courierName, cn }) => {
  const provider = providerFor(courierName);
  if (!provider?.cancel) return false;
  await provider.cancel({ cn });
  return true;
};
