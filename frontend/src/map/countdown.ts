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

/** `msLeft` rendered as `mm:ss`, rounding up so the last second is visible. */
export function mmss(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
