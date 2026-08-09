import { useEffect, useState } from 'react';
import styled from 'styled-components';

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
`;

const Countdown = styled.p`
  margin: 0;
  font-size: 15px;
  color: #22222a;
`;

const Clock = styled.strong`
  font-variant-numeric: tabular-nums;
`;

const Button = styled.button<{ $primary?: boolean }>`
  padding: 9px 16px;
  font: inherit;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid ${(p) => (p.$primary ? '#2f6df6' : '#c9c9d1')};
  background: ${(p) => (p.$primary ? '#2f6df6' : '#fff')};
  color: ${(p) => (p.$primary ? '#fff' : '#22222a')};

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const Toast = styled.p`
  flex-basis: 100%;
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid #f0c2bc;
  background: #fdf0ee;
  color: #c0392b;
  font-size: 14px;
`;

/** Milliseconds left on the hold, floored at 0. */
function msLeft(expiresAt: string | null): number {
  if (expiresAt === null) return 0;
  const left = Date.parse(expiresAt) - Date.now();
  return Number.isNaN(left) ? 0 : Math.max(0, left);
}

function mmss(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface ReservationBarProps {
  /** Server timestamp the hold expires at, or `null` when nothing is held. */
  expiresAt: string | null;
  seatCount: number;
  /** A mutation is in flight — no second one until it settles. */
  busy: boolean;
  error: string | null;
  onExpire: () => void;
  onBook: () => void;
  onReset: () => void;
}

/**
 * Hold countdown plus the two group-level commands.
 *
 * The countdown is derived from the server's `expiresAt` against the local
 * clock: a skewed client shows a slightly wrong number, but the server stays
 * the only authority on when the hold really dies, and any action taken past
 * that point is rejected with `EXPIRED`.
 */
export default function ReservationBar({
  expiresAt,
  seatCount,
  busy,
  error,
  onExpire,
  onBook,
  onReset,
}: ReservationBarProps) {
  const [left, setLeft] = useState(() => msLeft(expiresAt));

  useEffect(() => {
    setLeft(msLeft(expiresAt));
    if (expiresAt === null) return;
    const timer = setInterval(() => setLeft(msLeft(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (expiresAt !== null && left <= 0) onExpire();
  }, [expiresAt, left, onExpire]);

  const held = expiresAt !== null;

  return (
    <Bar>
      <Countdown aria-live="polite">
        {held ? (
          <>
            Holding {seatCount} seat{seatCount === 1 ? '' : 's'} — expires in{' '}
            <Clock>{mmss(left)}</Clock>
          </>
        ) : (
          'No seats held. Drag across free seats to hold a row.'
        )}
      </Countdown>

      <Button type="button" $primary disabled={!held || busy} onClick={onBook}>
        Book
      </Button>
      <Button type="button" disabled={!held || busy} onClick={onReset}>
        Reset
      </Button>

      {error !== null && <Toast role="alert">{error}</Toast>}
    </Bar>
  );
}
