import * as bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;

/**
 * A real bcrypt hash of a throwaway password. Used so that a login attempt for
 * an unknown username still performs one bcrypt comparison, keeping the
 * response time (and the response body) indistinguishable from a wrong-password
 * attempt against an existing user.
 */
const DUMMY_HASH = bcrypt.hashSync('Dummy-Password-1', BCRYPT_ROUNDS);

/**
 * Server-side password policy: at least 6 characters, with at least one
 * uppercase letter, one lowercase letter and one digit.
 *
 * @returns a human-readable error message, or `null` when the password is valid.
 */
export function validatePasswordPolicy(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 6) {
    return 'Password must be at least 6 characters long';
  }
  if (!/[A-Z]/.test(pw)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[a-z]/.test(pw)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/[0-9]/.test(pw)) {
    return 'Password must contain at least one digit';
  }
  return null;
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

/**
 * Burn the same amount of work as a real password check when there is no user
 * to check against. Always resolves false.
 */
export async function verifyPasswordAgainstDummy(pw: string): Promise<boolean> {
  await bcrypt.compare(typeof pw === 'string' ? pw : '', DUMMY_HASH);
  return false;
}
