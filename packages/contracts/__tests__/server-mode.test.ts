import { describe, expect, it } from 'vitest';
import {
  CreateServerRequestSchema,
  EXTERNAL_SERVER_ROLES,
  SERVER_MODES,
  SERVER_ROLES,
  UpdateServerRequestSchema,
} from '../src/index.js';

/**
 * An external server is a database specbook is only a CLIENT of: it is reached
 * over the network with a credential, never over SSH, so it can hold only the
 * roles that need no local execution. These are the rules the form relies on —
 * if the schema stops enforcing them, a half-configured server reaches the
 * database and fails later at provision time instead of here.
 */
const base = { name: 'ovh-staging-db', host: '198.244.200.168', port: 35427 };

describe('server mode', () => {
  it('defaults to a specbook-managed server needing no credential', () => {
    const parsed = CreateServerRequestSchema.parse({ ...base, port: 22, roles: ['app'] });
    expect(parsed.mode).toBeUndefined();
    expect(SERVER_MODES).toContain('specbook');
  });

  it('accepts an external database server with its provisioning credential', () => {
    const parsed = CreateServerRequestSchema.parse({
      ...base,
      mode: 'external',
      roles: ['database'],
      adminUser: 'specbook_provisioner',
      adminSecret: 'k7Qm2xR9',
      caCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    });
    expect(parsed.adminUser).toBe('specbook_provisioner');
  });

  it('refuses an external server with no credential to authenticate as', () => {
    const result = CreateServerRequestSchema.safeParse({
      ...base,
      mode: 'external',
      roles: ['database'],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['adminUser', 'adminSecret']),
    );
  });

  it.each(['app', 'build', 'runner'] as const)(
    'refuses role %s on an external server — it needs SSH',
    (role) => {
      const result = CreateServerRequestSchema.safeParse({
        ...base,
        mode: 'external',
        roles: [role],
        adminUser: 'specbook_provisioner',
        adminSecret: 'k7Qm2xR9',
      });
      expect(result.success).toBe(false);
      expect(EXTERNAL_SERVER_ROLES as readonly string[]).not.toContain(role);
    },
  );

  it('refuses a credential on a managed server — it has nowhere to use one', () => {
    const result = CreateServerRequestSchema.safeParse({
      ...base,
      port: 22,
      roles: ['app'],
      adminUser: 'specbook_provisioner',
      adminSecret: 'k7Qm2xR9',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a CA field that is not a PEM certificate', () => {
    const result = CreateServerRequestSchema.safeParse({
      ...base,
      mode: 'external',
      roles: ['database'],
      adminUser: 'specbook_provisioner',
      adminSecret: 'k7Qm2xR9',
      caCert: '/root/postgres-ca.crt',
    });
    expect(result.success).toBe(false);
  });
});

/**
 * A runner hosts the agent CLI unattended with permission prompts skipped
 * (remote-ops `runner-start`: IS_SANDBOX=1 --dangerously-skip-permissions).
 * That is only defensible on a box dedicated to it. Until this rule the
 * requirement lived in a README, so nothing stopped a runner being placed
 * beside the app and data containers it could then reach.
 */
/**
 * A runner hosts the agent CLI with permission prompts skipped, so sharing a
 * box puts an agent that can run anything beside that box's app and data
 * containers. That is a real risk and a legitimate choice, so the SCHEMA stays
 * out of it and the form warns instead. These tests pin that decision: if a
 * refusal ever appears here, a considered setup becomes an error with no way
 * past it.
 */
describe('runner may share a box, deliberately', () => {
  it.each(SERVER_ROLES.filter((r) => r !== 'runner' && r !== 'database' && r !== 'cache'))(
    'accepts runner alongside %s',
    (role) => {
      const parsed = CreateServerRequestSchema.parse({ ...base, port: 22, roles: ['runner', role] });
      expect(parsed.roles).toEqual(['runner', role]);
    },
  );

  it('accepts the same pairing on update', () => {
    const result = UpdateServerRequestSchema.safeParse({
      id: '0195f2a1-0000-7000-8000-000000000000',
      roles: ['app', 'runner'],
    });
    expect(result.success).toBe(true);
  });
});
