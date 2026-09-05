import { NotFoundException } from '@nestjs/common';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveUser } from '@pkg/contracts';
import { ApiKeyService } from '@/api-key/api-key.service.js';
import type { ApiKeyRepository } from '@/api-key/api-key.repository.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const ORG = '99999999-9999-4999-8999-999999999999';
const creator: ActiveUser = {
  userId: 'u1',
  orgId: ORG,
  orgRole: 'OWNER',
  systemRole: 'ADMIN',
};

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let repository: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    repository = {
      insert: vi.fn().mockImplementation((row: object) =>
        Promise.resolve({
          id: '11111111-1111-4111-8111-111111111111',
          lastUsedAt: null,
          revokedAt: null,
          createdAt: now,
          ...row,
        }),
      ),
      listActive: vi.fn().mockResolvedValue([]),
      findActiveByHash: vi.fn().mockResolvedValue(null),
      revoke: vi.fn().mockResolvedValue(true),
      touchLastUsed: vi.fn().mockResolvedValue(undefined),
      findOrgStanding: vi.fn().mockResolvedValue({ orgRole: 'OWNER', systemRole: 'ADMIN' }),
    };
    service = new ApiKeyService(
      repository as unknown as ApiKeyRepository,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  it('returns the plaintext once and stores only its hash', async () => {
    const created = await service.create(creator, { name: 'ci', scopes: ['orgs:read'] });

    expect(created.key).toMatch(/^sk_/);
    const stored = repository.insert!.mock.calls[0]![0] as { hashedKey: string; prefix: string };
    expect(stored.hashedKey).not.toContain(created.key);
    expect(stored.hashedKey).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, not plaintext
    expect(created.key.startsWith(stored.prefix)).toBe(true);
  });

  it('deduplicates granted scopes', async () => {
    await service.create(creator, { name: 'ci', scopes: ['orgs:read', 'orgs:read'] });

    const stored = repository.insert!.mock.calls[0]![0] as { scopes: string[] };
    expect(stored.scopes).toEqual(['orgs:read']);
  });

  it('verifies a token by hash and returns its scopes', async () => {
    const created = await service.create(creator, { name: 'ci', scopes: ['platform:read'] });
    const stored = repository.insert!.mock.calls[0]![0] as { hashedKey: string };
    repository.findActiveByHash!.mockResolvedValue({
      id: 'k1',
      name: 'ci',
      scopes: ['platform:read'],
      hashedKey: stored.hashedKey,
    });

    const auth = await service.verify(created.key);

    expect(repository.findActiveByHash).toHaveBeenCalledWith(stored.hashedKey);
    expect(auth).toMatchObject({ keyId: 'k1', scopes: ['platform:read'] });
  });

  it('binds the key to the creator organization', async () => {
    await service.create(creator, { name: 'ci', scopes: ['tasks:agent'] });

    const stored = repository.insert!.mock.calls[0]![0] as { orgId: string };
    expect(stored.orgId).toBe(ORG);
  });

  it('resolves an org-bound key to the ActiveUser it acts as', async () => {
    repository.findActiveByHash!.mockResolvedValue({
      id: 'k1',
      name: 'ci',
      scopes: ['tasks:agent'],
      userId: 'u1',
      orgId: ORG,
    });

    const auth = await service.verify('sk_whatever');

    expect(auth?.activeUser).toEqual({
      userId: 'u1',
      orgId: ORG,
      orgRole: 'OWNER',
      systemRole: 'ADMIN',
      // A machine identity — this is what keeps agents org-wide under scoping.
      isAgent: true,
    });
  });

  // Membership is the live source of authority: no membership, no org powers —
  // the key degrades to platform scopes instead of impersonating a past role.
  it('degrades an org-bound key to activeUser null when membership is gone', async () => {
    repository.findActiveByHash!.mockResolvedValue({
      id: 'k1',
      name: 'ci',
      scopes: ['tasks:agent'],
      userId: 'u1',
      orgId: ORG,
    });
    repository.findOrgStanding!.mockResolvedValue(null);

    const auth = await service.verify('sk_whatever');

    expect(auth).not.toBeNull();
    expect(auth?.activeUser).toBeNull();
  });

  it('answers null for an unknown or revoked token', async () => {
    await expect(service.verify('sk_nonsense')).resolves.toBeNull();
  });

  it('reports revoking an unknown key as not found', async () => {
    repository.revoke!.mockResolvedValue(false);

    await expect(service.revoke('missing')).rejects.toThrow(NotFoundException);
  });

  // The list is what an admin sees — it must never carry hashes or plaintext.
  it('never exposes the hash in the list view', async () => {
    repository.listActive!.mockResolvedValue([
      {
        id: 'k1',
        name: 'ci',
        prefix: 'sk_abc',
        hashedKey: 'deadbeef',
        scopes: ['orgs:read'],
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
      },
    ]);

    const { data } = await service.list();

    expect(JSON.stringify(data)).not.toContain('deadbeef');
  });
});
