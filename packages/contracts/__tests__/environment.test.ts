import { describe, expect, it } from 'vitest';
import {
  MAX_EXTRA_DOMAINS,
  RESERVED_APP_NAMES,
  classifyEnvVarName,
  parseDotenv,
  routesApi,
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

  /** The repository decides which apps exist, so any well-formed name is accepted. */
  it('lets a hostname point at any app name, with or without the api beside it', () => {
    const parsed = UpdateEnvironmentRequestSchema.parse({
      ...base,
      extraDomains: [
        { domain: 'example.com', serves: 'landing' },
        { domain: 'docs.example.com', serves: 'docs-site', withApi: true },
      ],
    });
    expect(parsed.extraDomains?.map((d) => d.serves)).toEqual(['landing', 'docs-site']);
    expect(parsed.extraDomains?.[0]?.withApi).toBeUndefined();
  });

  /** An app name becomes an image tag, a compose service and an nginx upstream. */
  it('refuses an app name that is not a plain lowercase name', () => {
    for (const serves of ['Landing', 'my_app', '9lives', 'a b', 'web;id', '', 'x'.repeat(32)]) {
      expect(
        UpdateEnvironmentRequestSchema.safeParse({
          ...base,
          extraDomains: [{ domain: 'a.example.com', serves }],
        }).success,
        serves,
      ).toBe(false);
    }
  });

  /** The worker has no HTTP listener; migrate and proxy are the stack's own services. */
  it('refuses the names a hostname cannot point at', () => {
    for (const serves of RESERVED_APP_NAMES) {
      expect(
        UpdateEnvironmentRequestSchema.safeParse({
          ...base,
          extraDomains: [{ domain: 'a.example.com', serves }],
        }).success,
        serves,
      ).toBe(false);
    }
  });

  it('refuses the same name twice, and more than the limit', () => {
    const bad = (extraDomains: unknown) =>
      UpdateEnvironmentRequestSchema.safeParse({ ...base, extraDomains }).success;
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

describe('routesApi — does a hostname carry the api too?', () => {
  it('always does for the api app', () => {
    expect(routesApi({ serves: 'api' })).toBe(true);
    expect(routesApi({ serves: 'api', withApi: false })).toBe(true);
  });

  /** The web app calls the api on its own address; a landing page does not. */
  it('defaults to yes for the web app and no for anything else', () => {
    expect(routesApi({ serves: 'web' })).toBe(true);
    expect(routesApi({ serves: 'landing' })).toBe(false);
    expect(routesApi({ serves: 'docs', withApi: null })).toBe(false);
  });

  it('follows an explicit choice', () => {
    expect(routesApi({ serves: 'web', withApi: false })).toBe(false);
    expect(routesApi({ serves: 'landing', withApi: true })).toBe(true);
  });
});
