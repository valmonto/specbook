import { describe, expect, it } from 'vitest';
import {
  MAX_EXTRA_DOMAINS,
  classifyEnvVarName,
  parseDotenv,
} from '../src/constants/environment.js';
import { UpdateEnvironmentRequestSchema } from '../src/schemas/environment.schema.js';

describe('classifyEnvVarName', () => {
  it('defaults credential-shaped names to secret, everything else to config', () => {
    for (const name of ['API_KEY', 'DB_PASSWORD', 'GH_TOKEN', 'JWT_SECRET', 'AWS_CREDENTIALS']) {
      expect(classifyEnvVarName(name)).toBe('secret');
    }
    for (const name of ['PORT', 'PUBLIC_URL', 'NODE_ENV', 'LOG_LEVEL']) {
      expect(classifyEnvVarName(name)).toBe('config');
    }
  });
});

describe('parseDotenv', () => {
  it('parses KEY=value lines, ignoring comments and blanks, stripping quotes', () => {
    const result = parseDotenv(
      [
        '# a comment',
        '',
        'API_KEY=sk-123',
        'PUBLIC_URL="https://example.com"',
        "NAME='quoted'",
        'export FOO=bar',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      { name: 'API_KEY', value: 'sk-123' },
      { name: 'PUBLIC_URL', value: 'https://example.com' },
      { name: 'NAME', value: 'quoted' },
      { name: 'FOO', value: 'bar' },
    ]);
  });

  it('uppercases names and keeps `=` inside the value', () => {
    const result = parseDotenv('token=a=b=c');
    expect(result).toEqual({ ok: true, entries: [{ name: 'TOKEN', value: 'a=b=c' }] });
  });

  it('fails the WHOLE parse and reports every bad line (never a partial apply)', () => {
    const result = parseDotenv(['GOOD=1', 'NOEQUALS', '=novalue', '1BAD=x', 'GOOD=2'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { line: 2, raw: 'NOEQUALS', reason: 'missingEquals' },
      { line: 3, raw: '=novalue', reason: 'emptyKey' },
      { line: 4, raw: '1BAD=x', reason: 'badName' },
      { line: 5, raw: 'GOOD=2', reason: 'duplicate' },
    ]);
  });
});

describe('extra hostnames on an environment', () => {
  const base = {
    projectId: '019fb88d-6a59-75ac-be64-1317503e4888',
    id: '019fb88d-6a59-75ac-be64-1317503e4889',
  };

  it('accepts a short list of well-formed hostnames, each saying what it serves', () => {
    const parsed = UpdateEnvironmentRequestSchema.parse({
      ...base,
      extraDomains: [
        { domain: 'app.example.com', serves: 'api' },
        { domain: 'www.example.com', serves: 'web' },
      ],
    });
    expect(parsed.extraDomains).toHaveLength(2);
  });

  it('leaves the list untouched when the field is omitted', () => {
    expect(UpdateEnvironmentRequestSchema.parse(base).extraDomains).toBeUndefined();
  });

  /** These become Caddy site names and shell arguments on the target box. */
  it('refuses anything that is not a plain lowercase hostname', () => {
    for (const domain of [
      'App.Example.com',
      'example',
      'a b.example.com',
      '*.example.com',
      'a.example.com; rm -rf /',
    ]) {
      expect(
        UpdateEnvironmentRequestSchema.safeParse({
          ...base,
          extraDomains: [{ domain, serves: 'web' }],
        }).success,
      ).toBe(false);
    }
  });

  it('refuses an unknown "serves", the same name twice, and more than the limit', () => {
    const bad = (extraDomains: unknown) =>
      UpdateEnvironmentRequestSchema.safeParse({ ...base, extraDomains }).success;
    expect(bad([{ domain: 'a.example.com', serves: 'landing' }])).toBe(false);
    expect(
      bad([
        { domain: 'a.example.com', serves: 'web' },
        { domain: 'a.example.com', serves: 'api' },
      ]),
    ).toBe(false);
    expect(
      bad(
        Array.from({ length: MAX_EXTRA_DOMAINS + 1 }, (_, i) => ({
          domain: `h${i}.example.com`,
          serves: 'web',
        })),
      ),
    ).toBe(false);
  });
});
