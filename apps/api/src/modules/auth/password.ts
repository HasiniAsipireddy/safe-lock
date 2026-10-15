import argon2 from 'argon2';

/**
 * Password hashing.
 *
 * argon2id with the OWASP-recommended baseline: 19 MiB of memory, 2 passes,
 * 1 degree of parallelism. These parameters are stored inside the hash string,
 * so raising them later does not invalidate existing hashes.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/**
 * Verifies a password against a stored hash. Returns false rather than
 * throwing on a malformed hash, so a corrupt row cannot turn into a 500 that
 * distinguishes it from a wrong password.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
