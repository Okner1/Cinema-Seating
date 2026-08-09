import type { Seat } from './useSeatMap';

/** A seat blocks the drag when someone else holds or owns it. */
function isOccupied(seat: Seat): boolean {
  return seat.status !== 'available' && !seat.mine;
}

/**
 * Seat ids covered by a drag from `anchor` toward `cursor`.
 *
 * The range is computed from the two endpoints — never by collecting hovered
 * seats — so it is consecutive by construction, and it is confined to the
 * anchor's row (Rule 1). Walking outward from the anchor stops *before* the
 * first occupied seat, so a range can never jump over a reserved or booked one.
 *
 * A cursor outside the anchor's row leaves the range untouched: `sofar` (the
 * range the drag had reached) is returned as-is, defaulting to the anchor alone
 * when the drag has not moved yet.
 *
 * `rowSeats` are the seats of the anchor's row, in any order. Returned ids are
 * ordered by seat number, whichever way the drag ran.
 */
export function computeDragRange(
  anchor: Seat,
  cursor: Seat,
  rowSeats: Seat[],
  sofar: number[] = [anchor.id],
): number[] {
  if (cursor.row !== anchor.row) return sofar;

  const byNumber = new Map(rowSeats.map((seat) => [seat.number, seat]));
  const step = Math.sign(cursor.number - anchor.number);
  const ids = [anchor.id];

  if (step !== 0) {
    for (let n = anchor.number + step; ; n += step) {
      const seat = byNumber.get(n);
      // A gap in the row's numbering ends the range just as an occupied seat does.
      if (seat === undefined || isOccupied(seat)) break;
      ids.push(seat.id);
      if (n === cursor.number) break;
    }
  }

  return step < 0 ? ids.reverse() : ids;
}
