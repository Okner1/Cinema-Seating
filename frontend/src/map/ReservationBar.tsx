import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { mmss, msLeft } from './countdown';

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

  // Expiry is decided inside the tick, from `expiresAt` alone. Deciding it in a
  // separate effect over the `left` state would fire on the render where a hold
  // first appears — while `left` still held the previous 0 — and kill the hold
  // the moment it was created.
  useEffect(() => {
    if (expiresAt === null) {
      setLeft(0);
      return;
    }
    const tick = () => {
      const ms = msLeft(expiresAt);
      setLeft(ms);
      if (ms <= 0) onExpire();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, onExpire]);

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
