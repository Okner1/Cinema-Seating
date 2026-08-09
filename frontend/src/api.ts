/** Error envelope returned by the backend on any non-2xx response. */
interface ErrorEnvelope {
  error: string;
  code: string;
}

/** Thrown by `api()` for every non-2xx response. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Thin fetch wrapper for the backend REST API.
 *
 * Always sends cookies (the session is an httpOnly cookie) and JSON headers.
 * Non-2xx responses are parsed from the `{ error, code }` envelope and thrown
 * as `ApiError`; 2xx responses are parsed as JSON (empty bodies yield
 * `undefined`).
 */
export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });

  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    let code = 'UNKNOWN';
    try {
      const body = (await res.json()) as Partial<ErrorEnvelope>;
      if (typeof body.error === 'string' && body.error !== '') message = body.error;
      if (typeof body.code === 'string' && body.code !== '') code = body.code;
    } catch {
      // Non-JSON error body (proxy/gateway error) — keep the defaults.
    }
    throw new ApiError(message, code, res.status);
  }

  const text = await res.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** Message to show a user for anything thrown out of `api()`. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Network error — please try again.';
}
