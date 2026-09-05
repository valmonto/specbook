import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { SecretsService } from '../../../src/modules/secrets/secrets.service.js';

const key = () => randomBytes(32).toString('base64');
const make = (k: string) => new SecretsService({ get: () => k } as unknown as ConfigService);

describe('SecretsService — the write-only value primitive', () => {
  it('round-trips arbitrary utf8', () => {
    const svc = make(key());
    const plain = 'ssh-private-key-🗝️\nline2';
    const sealed = svc.seal(plain);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(plain);
    expect(svc.open(sealed)).toBe(plain);
  });

  it('two seals of the same value differ (fresh IV every time)', () => {
    const svc = make(key());
    expect(svc.seal('same')).not.toBe(svc.seal('same'));
  });

  it('a different key cannot open the blob', () => {
    const sealed = make(key()).seal('secret');
    expect(() => make(key()).open(sealed)).toThrow();
  });

  it('tampered ciphertext fails authentication', () => {
    const svc = make(key());
    const sealed = svc.seal('secret');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[14] = (raw[14] ?? 0) ^ 0xff;
    expect(() => svc.open(`v1:${raw.toString('base64')}`)).toThrow();
  });

  it('rejects unknown blob versions and malformed keys', () => {
    expect(() => make(key()).open('v9:whatever')).toThrow(/version/);
    expect(() => make('short')).toThrow(/32 bytes/);
    expect(() => make('')).toThrow(/required/);
  });
});
