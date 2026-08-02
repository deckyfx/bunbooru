/**
 * Shared field styling for form inputs, so the base look lives in ONE place.
 * `TEXT_INPUT_BASE` omits horizontal padding; each consumer adds its own
 * (`px-2.5` for a plain field, `pl-2.5 pr-10` when a field has a trailing icon
 * button) — kept separate so the paddings never conflict when concatenated.
 */
export const TEXT_INPUT_BASE =
  "block w-full rounded-md border border-line bg-bg py-2 text-sm outline-none transition-colors focus:border-link focus:ring-1 focus:ring-link/30";

/** Standard text field (login/signup and similar). */
export const TEXT_INPUT = `${TEXT_INPUT_BASE} px-2.5`;
