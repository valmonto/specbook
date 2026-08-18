import { randomInt } from 'node:crypto';

/**
 * The SEED_INITIAL_PASSWORD generator.
 *
 * Domain-blind — belongs to the valmatic template as much as to specbook:
 * every valmatic-descended app enforces the SAME password policy on the
 * initial-admin seed (>= 8 chars including lowercase, uppercase, number and a
 * special character — see `PASSWORD_REGEX` in @pkg/contracts). The old seed
 * generator emitted a strictly-alphanumeric string, so the seeder's own
 * validation rejected it: no admin user was created and the fresh staging was
 * un-loginable until an operator supplied a Secret by hand.
 *
 * NOTE for the general secret generator (unit DB passwords, IAM_JWT_SECRET,
 * …): those stay STRICTLY ALPHANUMERIC on purpose — they ride inside a
 * postgres URL, shell argv and SQL, where a special character would need
 * escaping. This generator is the seed login ONLY, whose value is consumed as
 * a plain login credential, never interpolated into a URL.
 */

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGIT = '0123456789';
// .env-safe specials: no `$` (compose interpolation), `#` (comment), quotes,
// backslash, backtick or whitespace — each still counts as the policy's
// required non-alphanumeric character, and none can corrupt the rendered .env.
const SPECIAL = '!@%^&*()-_=+.?';
const ALL = LOWER + UPPER + DIGIT + SPECIAL;

const pick = (alphabet: string): string => alphabet[randomInt(alphabet.length)]!;

/**
 * A random password that ALWAYS satisfies the policy: it seeds one guaranteed
 * character from each class, fills the rest from the full alphabet, then
 * Fisher–Yates shuffles so the guaranteed characters aren't positionally
 * predictable. Default length 20 (well past the 8-char floor) for entropy.
 */
export function generateSeedPassword(length = 20): string {
  if (length < 4) throw new Error('seed password length must be at least 4');
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SPECIAL)];
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
