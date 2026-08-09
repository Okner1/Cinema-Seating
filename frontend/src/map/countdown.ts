/**
 * Milliseconds left on a hold, floored at 0.
 *
 * Always derived from the server's `expiresAt` against the local clock — never
 * from a previously computed value — so a hold that was just created reads as
 * live on the very first evaluation. `null` (no hold) and an unparseable
 * timestamp both read as 0.
 */
export function msLeft(expiresAt: string | null, now: number = Date.now()): number {
  if (expiresAt === null) return 0;
  const left = Date.parse(expiresAt) - now;
  return Number.isNaN(left) ? 0 : Math.max(0, left);
}

/** One evaluation of the countdown: what to display, and whether the hold is over. */
export interface ExpiryTick {
  left: number;
  expired: boolean;
}

/**
 * The whole countdown decision, as a pure function of `expiresAt` and the clock.
 *
 * `expired` is true only when a hold exists *and* has lapsed — never for `null`
 * (nothing to expire) and never while time remains. Keeping the decision here,
 * rather than in an effect comparing against previously rendered state, is what
 * makes it impossible for a hold to be declared expired on the render where it
 * first appears.
 */
export function expiryTick(expiresAt: string | null, now: number = Date.now()): ExpiryTick {
  const left = msLeft(expiresAt, now);
  return { left, expired: expiresAt !== null && left <= 0 };
}

/** `msLeft` rendered as `mm:ss`, rounding up so the last second is visible. */
export function mmss(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
