import { describe, expect, it } from 'vitest';
import { PASSWORD_REGEX } from '@pkg/contracts';
import { generateSeedPassword } from '../../../src/modules/deploy/seed-password.js';

describe('generateSeedPassword', () => {
  // Enough runs to make a probabilistic miss (a class the shuffle happened to
  // omit) astronomically unlikely — this is the whole point of the generator.
  const samples = Array.from({ length: 2000 }, () => generateSeedPassword());

  it('every generation satisfies the app password policy (the real regex)', () => {
    for (const pw of samples) expect(pw).toMatch(PASSWORD_REGEX);
  });

  it('every generation includes at least one of each character class', () => {
    for (const pw of samples) {
      expect(pw, `lowercase in ${pw}`).toMatch(/[a-z]/);
      expect(pw, `uppercase in ${pw}`).toMatch(/[A-Z]/);
      expect(pw, `digit in ${pw}`).toMatch(/\d/);
      expect(pw, `special in ${pw}`).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('is at least 8 characters and honours a requested length', () => {
    for (const pw of samples) expect(pw.length).toBeGreaterThanOrEqual(8);
    expect(generateSeedPassword(32)).toHaveLength(32);
    // The default (and any length >= 8) clears the policy's 8-char floor; the
    // real seeds are minted at that default, never at the 4-char minimum.
    expect(generateSeedPassword()).toMatch(PASSWORD_REGEX);
    // At the shortest allowed length all four classes still fit (though 4
    // chars is below the policy's own 8-char floor).
    const short = generateSeedPassword(4);
    expect(short).toHaveLength(4);
    expect(short).toMatch(/[a-z]/);
    expect(short).toMatch(/[A-Z]/);
    expect(short).toMatch(/\d/);
    expect(short).toMatch(/[^A-Za-z0-9]/);
  });

  it('stays .env-safe: no newline, quote, backslash, backtick, whitespace, $ or #', () => {
    for (const pw of samples) expect(pw).not.toMatch(/[\s"'`\\$#]/);
  });

  it('is random — no two generations collide across the sample', () => {
    expect(new Set(samples).size).toBe(samples.length);
  });

  it('does not put the guaranteed classes in fixed positions (shuffled)', () => {
    // If the four seeded characters were never shuffled, position 0 would
    // always be lowercase and position 3 always special. Across many samples
    // both positions must show variety.
    const firsts = new Set(samples.map((pw) => pw[0]));
    const fourths = new Set(samples.map((pw) => pw[3]));
    expect(firsts.size).toBeGreaterThan(1);
    expect(fourths.size).toBeGreaterThan(1);
  });

  it('rejects a length that cannot hold all four classes', () => {
    expect(() => generateSeedPassword(3)).toThrow();
  });
});
