import { describe, expect, it } from 'vitest';
import { classifyEnvVarName, parseDotenv } from '../src/constants/environment';

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
      ['# a comment', '', 'API_KEY=sk-123', 'PUBLIC_URL="https://example.com"', "NAME='quoted'", 'export FOO=bar'].join(
        '\n',
      ),
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
