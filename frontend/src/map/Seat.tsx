import styled from 'styled-components';
import type { Seat as SeatModel } from './useSeatMap';

export type SeatTone = 'available' | 'reserved' | 'booked' | 'mine';

const FILL: Record<SeatTone, string> = {
  available: '#d3d4da',
  reserved: '#e79a3c',
  booked: '#d0453b',
  mine: '#3fa96a',
};

/**
 * How a seat should look. Booked wins over ownership: once the group is booked
 * the hold is gone, so the seat reads as taken rather than held by us.
 */
function seatTone(seat: SeatModel): SeatTone {
  if (seat.status === 'booked') return 'booked';
  if (seat.mine) return 'mine';
  return seat.status;
}

const Circle = styled.button<{ $tone: SeatTone; $preview: boolean }>`
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.14);
  background: ${(p) => FILL[p.$tone]};
  cursor: ${(p) => (p.$tone === 'available' || p.$tone === 'mine' ? 'pointer' : 'default')};
  /* The drag preview must be readable on top of every fill colour. */
  outline: ${(p) => (p.$preview ? '3px solid #2f6df6' : 'none')};
  outline-offset: 1px;
`;

export interface SeatProps {
  seat: SeatModel;
  /** Inside the range the in-flight drag currently covers. */
  preview: boolean;
  onSeatMouseDown: (seat: SeatModel) => void;
  onSeatMouseEnter: (seat: SeatModel) => void;
  onSeatClick: (seat: SeatModel) => void;
}

/**
 * One seat. Never disabled: occupied seats must still report `mouseenter` so a
 * drag passing over them can clamp.
 */
export default function Seat({
  seat,
  preview,
  onSeatMouseDown,
  onSeatMouseEnter,
  onSeatClick,
}: SeatProps) {
  const tone = seatTone(seat);
  return (
    <Circle
      type="button"
      $tone={tone}
      $preview={preview}
      aria-label={`Row ${seat.row}, seat ${seat.number}, ${tone}`}
      onMouseDown={() => onSeatMouseDown(seat)}
      onMouseEnter={() => onSeatMouseEnter(seat)}
      onClick={() => onSeatClick(seat)}
    />
  );
}
