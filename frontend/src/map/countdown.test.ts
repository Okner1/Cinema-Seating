import { describe, expect, it } from 'vitest';
import { expiryTick, mmss, msLeft } from './countdown';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

describe('msLeft', () => {
  it('is 0 when nothing is held', () => {
    expect(msLeft(null, NOW)).toBe(0);
  });

  it('is positive the instant a fresh hold arrives', () => {
    // The regression this pins: a hold created *now* must never read as expired
    // on the render where `expiresAt` first appears, or the countdown would
    // clear it immediately and leave Book/Reset permanently disabled.
    const fresh = new Date(NOW + 15 * 60_000).toISOString();
    expect(msLeft(fresh, NOW)).toBe(15 * 60_000);
    expect(msLeft(fresh, NOW)).toBeGreaterThan(0);
  });

  it('depends only on expiresAt and the clock, not on any earlier reading', () => {
    // Same arguments, same answer — there is no state to go stale, which is what
    // lets the tick recompute expiry instead of trusting a captured value.
    const fresh = new Date(NOW + 60_000).toISOString();
    expect(msLeft(fresh, NOW)).toBe(msLeft(fresh, NOW));
    expect(msLeft(fresh, NOW + 45_000)).toBe(15_000);
  });

  it('floors at 0 once the hold has passed', () => {
    const past = new Date(NOW - 1).toISOString();
    expect(msLeft(past, NOW)).toBe(0);
    expect(msLeft(new Date(NOW).toISOString(), NOW)).toBe(0);
  });

  it('treats an unparseable timestamp as expired', () => {
    expect(msLeft('not-a-date', NOW)).toBe(0);
  });
});

describe('expiryTick', () => {
  it('never expires a hold that has just been granted', () => {
    // The regression: the countdown used to decide expiry by comparing the
    // previously rendered `left` (still 0) against the new `expiresAt`, so a
    // fresh hold was declared expired on the very render it arrived and wiped
    // immediately — leaving Book/Reset dead. The decision now comes from
    // `expiresAt` alone, so the null → ISO transition cannot expire anything.
    const fresh = new Date(NOW + 15 * 60_000).toISOString();
    expect(expiryTick(fresh, NOW).expired).toBe(false);
    expect(expiryTick(fresh, NOW)).toEqual({ left: 15 * 60_000, expired: false });
  });

  it('never expires when there is no hold', () => {
    expect(expiryTick(null, NOW).expired).toBe(false);
    expect(expiryTick(null, NOW)).toEqual({ left: 0, expired: false });
  });

  it('expires a hold that has lapsed', () => {
    expect(expiryTick(new Date(NOW - 1).toISOString(), NOW)).toEqual({ left: 0, expired: true });
    expect(expiryTick(new Date(NOW).toISOString(), NOW)).toEqual({ left: 0, expired: true });
  });

  it('flips to expired only once the clock passes expiresAt', () => {
    const held = new Date(NOW + 1_000).toISOString();
    expect(expiryTick(held, NOW + 999)).toEqual({ left: 1, expired: false });
    expect(expiryTick(held, NOW + 1_000)).toEqual({ left: 0, expired: true });
  });

  it('treats an unparseable timestamp as expired', () => {
    expect(expiryTick('not-a-date', NOW)).toEqual({ left: 0, expired: true });
  });
});

describe('mmss', () => {
  it('pads both fields', () => {
    expect(mmss(0)).toBe('00:00');
    expect(mmss(9_000)).toBe('00:09');
    expect(mmss(15 * 60_000)).toBe('15:00');
  });

  it('rounds up so the final second stays visible', () => {
    expect(mmss(1)).toBe('00:01');
    expect(mmss(59_400)).toBe('01:00');
  });
});
