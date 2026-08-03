import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { ActiveUser } from '@pkg/contracts';
import { SecretsService } from '@pkg/server';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerService } from '@/servers/server.service';
import type { ServerRepository } from '@/servers/server.repository';
import type { ServerCheckProducer } from '@pkg/server';

const ORG = '11111111-1111-4111-8111-111111111111';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'ADMIN', systemRole: 'USER' };

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  orgId: ORG,
  name: 'hetzner-1',
  host: 'h.example.com',
  port: 22,
  sshUser: 'deploy',
  roles: ['app'],
  publicKey: 'ssh-ed25519 AAAA test',
  privateKeyEnc: 'v1:SEALEDSEALEDSEALED',
  hostFingerprint: null,
  status: 'unverified',
  lastCheckedAt: null,
  createdBy: 'u',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('ServerService — generated credentials, write-only by construction', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let checks: { enqueueCheck: ReturnType<typeof vi.fn> };
  let service: ServerService;

  beforeEach(() => {
    repository = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => row(data)),
      findForOrg: vi.fn().mockResolvedValue({ data: [row()], total: 1 }),
      findById: vi.fn().mockResolvedValue(row()),
      update: vi.fn().mockImplementation((_id, _org, data: Record<string, unknown>) => row(data)),
      delete: vi.fn().mockResolvedValue(true),
    };
    checks = { enqueueCheck: vi.fn().mockResolvedValue(undefined) };
    const secrets = new SecretsService({
      get: () => randomBytes(32).toString('base64'),
    } as unknown as ConfigService);
    service = new ServerService(
      repository as unknown as ServerRepository,
      secrets,
      checks as unknown as ServerCheckProducer,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  const dto = { name: 'hetzner-1', host: 'h.example.com', roles: ['app' as const] };

  it('create GENERATES the keypair: sealed private half stored, OpenSSH public half stored', async () => {
    await service.create(actor, dto);
    const stored = repository.create!.mock.calls[0]![0] as Record<string, string>;
    expect(stored.publicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(stored.privateKeyEnc).toMatch(/^v1:/);
    expect(stored.privateKeyEnc).not.toContain('PRIVATE KEY');
  });

  it('no response from any surface carries key material or sealed blobs', async () => {
    const responses = [
      await service.create(actor, dto),
      await service.list(actor, { skip: 0, limit: 10 }),
      await service.getById(actor, 's1'),
      await service.update(actor, { id: 's1', name: 'renamed' }),
      await service.test(actor, 's1'),
    ];
    const flat = JSON.stringify(responses);
    expect(flat).not.toContain('privateKeyEnc');
    expect(flat).not.toContain('PRIVATE KEY');
    expect(flat).not.toContain('v1:');
  });

  it('changing host resets the pinned fingerprint and trust status', async () => {
    await service.update(actor, { id: 's1', host: 'new-host.example.com' });
    expect(repository.update).toHaveBeenCalledWith(
      's1',
      ORG,
      expect.objectContaining({ hostFingerprint: null, status: 'unverified' }),
    );
  });

  it('a rename alone keeps the pin', async () => {
    await service.update(actor, { id: 's1', name: 'renamed' });
    const patch = repository.update!.mock.calls[0]![2] as Record<string, unknown>;
    expect('hostFingerprint' in patch).toBe(false);
  });

  it('test enqueues the worker check — the API opens no sockets', async () => {
    await service.test(actor, 's1');
    expect(checks.enqueueCheck).toHaveBeenCalledWith('s1');
  });

  it('name collisions map to the translation key, not a 500', async () => {
    repository.create!.mockRejectedValue(
      Object.assign(new Error('dup'), {
        cause: { code: '23505', constraint_name: 'server_org_name_uq' },
      }),
    );
    await expect(service.create(actor, dto)).rejects.toThrow('servers.errors.nameTaken');
  });
});
