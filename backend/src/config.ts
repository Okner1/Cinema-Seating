function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export const config = {
  port: envInt('PORT', 4000),
  databaseUrl: envStr('DATABASE_URL', 'postgres://cinema:cinema@localhost:5432/cinema'),
  jwtSecret: envStr('JWT_SECRET', 'dev-secret-change-me'),
  holdMinutes: envInt('HOLD_MINUTES', 15),
  heartbeatMs: envInt('HEARTBEAT_MS', 5000),
  sweepIntervalMs: envInt('SWEEP_INTERVAL_MS', 30000),
};
