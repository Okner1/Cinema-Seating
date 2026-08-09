import styled from 'styled-components';
import type { ConnState } from './useSeatMap';

const Frosted = styled.div`
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
  border-radius: inherit;
  background: rgba(246, 246, 249, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
`;

const Message = styled.p`
  margin: 0;
  max-width: 34ch;
  font-size: 15px;
  color: #22222a;
`;

const RetryButton = styled.button`
  padding: 9px 16px;
  font: inherit;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid #2f6df6;
  background: #2f6df6;
  color: #fff;
`;

export interface OverlayProps {
  conn: ConnState;
  attempt: number;
  onRetry: () => void;
}

/**
 * Covers the seat map whenever the live connection is not usable, so a stale
 * grid can never be mistaken for current state.
 */
export default function Overlay({ conn, attempt, onRetry }: OverlayProps) {
  if (conn === 'open') return null;

  return (
    <Frosted role="status" aria-live="polite">
      {conn === 'connecting' && <Message>Connecting…</Message>}
      {conn === 'reconnecting' && (
        <Message>Connection lost — attempting to reconnect (attempt {attempt})…</Message>
      )}
      {conn === 'failed' && (
        <>
          <Message>
            Unable to reconnect automatically. Please wait a few minutes and try again.
          </Message>
          <RetryButton type="button" onClick={onRetry}>
            Retry
          </RetryButton>
        </>
      )}
    </Frosted>
  );
}
