import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { ApiError, api, errorMessage } from '../api';
import Overlay from '../map/Overlay';
import ReservationBar from '../map/ReservationBar';
import SeatGrid from '../map/SeatGrid';
import { computeDragRange } from '../map/selection';
import { useSeatMap, type MyReservation, type Seat } from '../map/useSeatMap';

interface MapInstance {
  id: number;
  name: string;
}


/** Body of every reservation mutation that leaves a live hold behind. */
interface ReservationResponse {
  reservationId: number;
  expiresAt: string;
  seatIds: number[];
}

const Screen = styled.main`
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
`;

const Select = styled.select`
  align-self: flex-start;
  min-width: 240px;
  padding: 8px 10px;
  font: inherit;
  border: 1px solid #c9c9d1;
  border-radius: 6px;
  background: #fff;
`;

/** Positioning context for the overlay, which covers exactly the map area. */
const MapArea = styled.div`
  position: relative;
  min-height: 320px;
  padding: 16px;
  border: 1px solid #d8d8dd;
  border-radius: 10px;
  background: #fff;
`;

const ErrorText = styled.p`
  margin: 0;
  color: #c0392b;
  font-size: 14px;
`;

/** Fixed top-center error toast; click dismisses. */
const TopToast = styled.button`
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  max-width: min(90vw, 560px);
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid #f0c2bc;
  background: #fdf0ee;
  color: #c0392b;
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
`;

/** In-flight drag: the seat it started on and the range reached so far. */
interface Drag {
  anchor: Seat;
  range: number[];
}

export default function MapPage() {
  const [instances, setInstances] = useState<MapInstance[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const { seats, myReservation: wsReservation, conn, attempt, retryNow } = useSeatMap(instanceId);

  const [myReservation, setMyReservation] = useState<MyReservation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Seat ids the current drag covers; empty when no drag is running. */
  const [preview, setPreview] = useState<number[]>([]);
  // Drag state lives in a ref: mousemove churn must not re-render the grid twice,
  // and the window-level mouseup below has to read the latest range.
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<MapInstance[]>('/map-instances')
      .then((list) => {
        if (!cancelled) setInstances(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Holds belong to one instance; switching maps leaves ours behind untouched
  // (it expires on its own) rather than pretending it applies here.
  useEffect(() => {
    drag.current = null;
    setPreview([]);
    setMyReservation(null);
    setActionError(null);
  }, [instanceId]);

  // The WS restates our held group on every message — all tabs converge on it;
  // mutation responses only pre-empt it for snappiness.
  useEffect(() => {
    setMyReservation(wsReservation);
  }, [wsReservation]);

  /**
   * Run one reservation mutation. The response is the only thing that updates
   * our hold — the seats themselves arrive over the websocket. A rejected
   * mutation surfaces the server's message, and an expired hold is dropped
   * locally so the buttons stop pretending it exists.
   */
  const mutate = useCallback((call: () => Promise<MyReservation | null>) => {
    setPending(true);
    call()
      .then((next) => {
        setMyReservation(next);
        setActionError(null);
      })
      .catch((err: unknown) => {
        setActionError(errorMessage(err));
        if (err instanceof ApiError && err.code === 'EXPIRED') setMyReservation(null);
      })
      .finally(() => setPending(false));
  }, []);

  /** Commit a finished drag: the range is added to whatever we already hold. */
  const commitRange = useCallback(
    (range: number[]) => {
      if (instanceId === null || range.length === 0 || pending) return;
      const current = myReservation;
      const seatIds =
        current === null ? range : [...new Set([...current.seatIds, ...range])];

      mutate(async () => {
        const res =
          current === null
            ? await api<ReservationResponse>('/reservations', {
                method: 'POST',
                body: JSON.stringify({ instanceId, seatIds }),
              })
            : await api<ReservationResponse>(`/reservations/${current.id}/seats`, {
                method: 'PATCH',
                body: JSON.stringify({ seatIds }),
              });
        return { id: res.reservationId, seatIds: res.seatIds, expiresAt: res.expiresAt };
      });
    },
    [instanceId, myReservation, pending, mutate],
  );

  // A drag can end anywhere — off a seat, off the map, outside the window.
  useEffect(() => {
    const onMouseUp = () => {
      const current = drag.current;
      if (current === null) return;
      drag.current = null;
      setPreview([]);
      commitRange(current.range);
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [commitRange]);

  const handleSeatMouseDown = (seat: Seat) => {
    // A drag begun mid-mutation would be committed against a hold that is about
    // to change, so `commitRange` refuses it. Refusing the drag up front keeps
    // the preview honest: nothing lights up that will not be sent.
    if (pending || seat.status !== 'available') return;
    drag.current = { anchor: seat, range: [seat.id] };
    setPreview([seat.id]);
  };

  const handleSeatMouseEnter = (seat: Seat) => {
    const current = drag.current;
    if (current === null) return;
    const rowSeats = [...seats.values()].filter((s) => s.row === current.anchor.row);
    const range = computeDragRange(current.anchor, seat, rowSeats, current.range);
    current.range = range;
    setPreview(range);
  };

  /** Clicking a seat we hold drops it — or releases the group if it was the last. */
  const handleSeatClick = (seat: Seat) => {
    const current = myReservation;
    if (pending || current === null || !seat.mine || !current.seatIds.includes(seat.id)) return;
    const seatIds = current.seatIds.filter((id) => id !== seat.id);

    mutate(async () => {
      if (seatIds.length === 0) {
        await api<void>(`/reservations/${current.id}`, { method: 'DELETE' });
        return null;
      }
      const res = await api<ReservationResponse>(`/reservations/${current.id}/seats`, {
        method: 'PATCH',
        body: JSON.stringify({ seatIds }),
      });
      return { id: res.reservationId, seatIds: res.seatIds, expiresAt: res.expiresAt };
    });
  };

  const handleReset = () => {
    const current = myReservation;
    if (current === null) return;
    mutate(async () => {
      await api<void>(`/reservations/${current.id}`, { method: 'DELETE' });
      return null;
    });
  };

  const handleBook = () => {
    const current = myReservation;
    if (current === null) return;
    mutate(async () => {
      await api<{ reservationId: number; status: string }>(`/reservations/${current.id}/book`, {
        method: 'POST',
      });
      // Booked seats are no longer a hold: nothing left to count down or release.
      return null;
    });
  };

  const handleExpire = useCallback(() => setMyReservation(null), []);

  return (
    <Screen>
      {actionError !== null && (
        <TopToast role="alert" onClick={() => setActionError(null)}>
          {actionError}
        </TopToast>
      )}
      <Title>Seat map</Title>

      <Select
        aria-label="Map instance"
        value={instanceId === null ? '' : String(instanceId)}
        onChange={(e) => setInstanceId(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">Select a map instance…</option>
        {instances.map((instance) => (
          <option key={instance.id} value={instance.id}>
            {instance.name}
          </option>
        ))}
      </Select>

      {loadError !== null && <ErrorText role="alert">{loadError}</ErrorText>}

      {instanceId !== null && (
        <>
          <MapArea>
            <SeatGrid
              seats={seats}
              preview={new Set(preview)}
              onSeatMouseDown={handleSeatMouseDown}
              onSeatMouseEnter={handleSeatMouseEnter}
              onSeatClick={handleSeatClick}
            />
            <Overlay conn={conn} attempt={attempt} onRetry={retryNow} />
          </MapArea>

          <ReservationBar
            expiresAt={myReservation === null ? null : myReservation.expiresAt}
            seatCount={myReservation === null ? 0 : myReservation.seatIds.length}
            busy={pending}
            onExpire={handleExpire}
            onBook={handleBook}
            onReset={handleReset}
          />
        </>
      )}
    </Screen>
  );
}
