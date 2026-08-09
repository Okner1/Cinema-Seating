import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { api, errorMessage } from '../api';
import Overlay from '../map/Overlay';
import { useSeatMap } from '../map/useSeatMap';

interface MapInstance {
  id: number;
  name: string;
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

const Placeholder = styled.p`
  margin: 0;
  color: #6b6b76;
  font-size: 14px;
`;

const ErrorText = styled.p`
  margin: 0;
  color: #c0392b;
  font-size: 14px;
`;

export default function MapPage() {
  const [instances, setInstances] = useState<MapInstance[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const { seats, conn, attempt, retryNow } = useSeatMap(instanceId);

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

  return (
    <Screen>
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
        <MapArea>
          {/* Task 12 replaces this placeholder with the real seat grid. */}
          <Placeholder>{seats.size} seats</Placeholder>
          <Overlay conn={conn} attempt={attempt} onRetry={retryNow} />
        </MapArea>
      )}
    </Screen>
  );
}
