import { describe, it, expect } from 'vitest';
import { isConsecutive, findTrappedSeat } from '../src/reservations/rules.js';

const row = (occ: number[], n = 10) =>
  Array.from({ length: n }, (_, i) => ({ seatNumber: i + 1, occupied: occ.includes(i + 1) }));

describe('isConsecutive', () => {
  it('accepts single seat', () => expect(isConsecutive([5])).toBe(true));
  it('accepts consecutive any order', () => expect(isConsecutive([7, 5, 6])).toBe(true));
  it('rejects gap', () => expect(isConsecutive([5, 7])).toBe(false));
  it('rejects empty', () => expect(isConsecutive([])).toBe(false));
  it('rejects duplicates', () => expect(isConsecutive([5, 5, 6])).toBe(false));
});

describe('findTrappedSeat', () => {
  it('PDF valid: 1,2 booked + select 3,4', () =>
    expect(findTrappedSeat(row([1, 2, 3, 4]))).toBeNull());
  it('PDF invalid: 1,2 booked + select 4,5 traps 3', () =>
    expect(findTrappedSeat(row([1, 2, 4, 5]))).toBe(3));
  it('PDF edge: select 2..10, seat 1 alone at wall is fine', () =>
    expect(findTrappedSeat(row([2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull());
  it('gap of two is fine', () => expect(findTrappedSeat(row([1, 4, 5]))).toBeNull());
  it('trap in middle', () => expect(findTrappedSeat(row([4, 6]))).toBe(5));
  it('empty row fine', () => expect(findTrappedSeat(row([]))).toBeNull());
  it('short row (5 seats) trap', () => expect(findTrappedSeat(row([1, 3], 5))).toBe(2));
});
