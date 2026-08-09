import styled from 'styled-components';
import Seat from './Seat';
import type { Seat as SeatModel } from './useSeatMap';

const Rows = styled.div`
  width: max-content;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* A drag across seats must not paint a text selection over the map. */
  user-select: none;
`;

const Row = styled.div<{ $centered: boolean }>`
  display: flex;
  gap: 10px;
  justify-content: ${(p) => (p.$centered ? 'center' : 'flex-start')};
`;

/** Seats grouped into rows, rows ascending and each row ordered by seat number. */
function groupRows(seats: Map<number, SeatModel>): SeatModel[][] {
  const byRow = new Map<number, SeatModel[]>();
  for (const seat of seats.values()) {
    const row = byRow.get(seat.row);
    if (row === undefined) byRow.set(seat.row, [seat]);
    else row.push(seat);
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((a, b) => a.number - b.number));
}

export interface SeatGridProps {
  seats: Map<number, SeatModel>;
  /** Seat ids the in-flight drag currently covers. */
  preview: ReadonlySet<number>;
  onSeatMouseDown: (seat: SeatModel) => void;
  onSeatMouseEnter: (seat: SeatModel) => void;
  onSeatClick: (seat: SeatModel) => void;
}

/**
 * The seat map: one flex line per row. Short rows (the back rows of the seeded
 * layout, 11–13) are centred against the widest row, which is what gives the
 * grid its auditorium shape.
 */
export default function SeatGrid({
  seats,
  preview,
  onSeatMouseDown,
  onSeatMouseEnter,
  onSeatClick,
}: SeatGridProps) {
  const rows = groupRows(seats);
  const widest = rows.reduce((max, row) => Math.max(max, row.length), 0);

  return (
    <Rows>
      {rows.map((row) => (
        <Row key={row[0].row} $centered={row.length < widest}>
          {row.map((seat) => (
            <Seat
              key={seat.id}
              seat={seat}
              preview={preview.has(seat.id)}
              onSeatMouseDown={onSeatMouseDown}
              onSeatMouseEnter={onSeatMouseEnter}
              onSeatClick={onSeatClick}
            />
          ))}
        </Row>
      ))}
    </Rows>
  );
}
