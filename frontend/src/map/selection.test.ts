import { describe, expect, it } from 'vitest';
import { computeDragRange } from './selection';
import type { Seat, SeatStatus } from './useSeatMap';

/** Build one row of seats; `overrides` patches individual seat numbers. */
function makeRow(
  row: number,
  count: number,
  overrides: Record<number, { status?: SeatStatus; mine?: boolean }> = {},
): Seat[] {
  return Array.from({ length: count }, (_, i) => {
    const number = i + 1;
    const patch = overrides[number] ?? {};
    return {
      id: row * 100 + number,
      row,
      number,
      status: patch.status ?? 'available',
      mine: patch.mine ?? false,
      expiresAt: null,
    };
  });
}

function seatAt(seats: Seat[], number: number): Seat {
  const seat = seats.find((s) => s.number === number);
  if (seat === undefined) throw new Error(`no seat ${number}`);
  return seat;
}

describe('computeDragRange', () => {
  it('returns just the anchor when the cursor is the anchor', () => {
    const row = makeRow(3, 10);
    const anchor = seatAt(row, 4);
    expect(computeDragRange(anchor, anchor, row)).toEqual([304]);
  });

  it('extends to the right', () => {
    const row = makeRow(3, 10);
    expect(computeDragRange(seatAt(row, 4), seatAt(row, 7), row)).toEqual([304, 305, 306, 307]);
  });

  it('extends to the left', () => {
    const row = makeRow(3, 10);
    expect(computeDragRange(seatAt(row, 7), seatAt(row, 4), row)).toEqual([304, 305, 306, 307]);
  });

  it('clamps before the first occupied seat', () => {
    const row = makeRow(3, 10, { 7: { status: 'reserved' } });
    // Dragging past seat 7 stops at 6 — the range never skips an occupied seat.
    expect(computeDragRange(seatAt(row, 4), seatAt(row, 9), row)).toEqual([304, 305, 306]);
  });

  it('clamps before an occupied seat when extending left', () => {
    const row = makeRow(3, 10, { 3: { status: 'booked' } });
    expect(computeDragRange(seatAt(row, 6), seatAt(row, 1), row)).toEqual([304, 305, 306]);
  });

  it('walks through seats that are already mine', () => {
    const row = makeRow(3, 10, { 5: { status: 'reserved', mine: true } });
    expect(computeDragRange(seatAt(row, 4), seatAt(row, 6), row)).toEqual([304, 305, 306]);
  });

  it('ignores a cursor in another row, keeping the range so far', () => {
    const row = makeRow(3, 10);
    const other = makeRow(4, 10);
    const sofar = computeDragRange(seatAt(row, 4), seatAt(row, 6), row);
    expect(computeDragRange(seatAt(row, 4), seatAt(other, 9), row, sofar)).toEqual(sofar);
  });

  it('falls back to the anchor alone for a cursor in another row with no range so far', () => {
    const row = makeRow(3, 10);
    const other = makeRow(4, 10);
    expect(computeDragRange(seatAt(row, 4), seatAt(other, 9), row)).toEqual([304]);
  });

  it('stops at a hole in the row numbering', () => {
    const row = makeRow(3, 10).filter((s) => s.number !== 6);
    expect(computeDragRange(seatAt(row, 4), seatAt(row, 8), row)).toEqual([304, 305]);
  });
});
