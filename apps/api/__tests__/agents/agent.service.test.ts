import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { PinoLogger } from 'nestjs-pino';
import { AGENT_OFFLINE_AFTER_MS, type ActiveUser } from '@pkg/contracts';
import { SecretsService, type AgentLifecycleProducer } from '@pkg/server';
import { FakeLogger } from '@pkg/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '@/agents/agent.service';
import type { AgentRepository } from '@/agents/agent.repository';
import type { ApiKeyService } from '@/api-key/api-key.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'ADMIN', systemRole: 'USER' };
const identity = { keyId: KEY, name: 'runner-1', activeUser: actor };

const SERVER = '44444444-4444-4444-8444-444444444444';

describe('AgentService — presence by API-key identity', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let apiKeys: Record<string, ReturnType<typeof vi.fn>>;
  let lifecycle: Record<string, ReturnType<typeof vi.fn>>;
  let service: AgentService;
  let stored: Record<string, unknown> | null;

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'a1',
    orgId: ORG,
    name: 'runner-1',
    apiKeyId: KEY,
    serverId: null,
    kind: 'external',
    status: 'idle',
    lastSeenAt: new Date(),
    currentTaskId: null,
    startedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    stored = null;
    repository = {
      findByApiKey: vi.fn().mockImplementation(() => stored),
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        stored = row(data);
        return stored;
      }),
      update: vi.fn().mockImplementation((_id, _org, patch: Record<string, unknown>) => {
        stored = { ...(stored ?? row()), ...patch };
        return stored;
      }),
      currentClaim: vi.fn().mockResolvedValue(null),
      listForOrg: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockImplementation(() => stored),
      findServer: vi.fn().mockResolvedValue({ id: SERVER, orgId: ORG, name: 'box', roles: ['runner'] }),
      findManagedByServer: vi.fn().mockResolvedValue([]),
    };
    apiKeys = {
      create: vi.fn().mockResolvedValue({ id: 'key-2', name: 'agent:runner-2', key: 'sk_plaintext_secret' }),
    };
    lifecycle = { enqueue: vi.fn().mockResolvedValue(undefined) };
    service = new AgentService(
      repository as unknown as AgentRepository,
      apiKeys as unknown as ApiKeyService,
      new SecretsService({ get: () => randomBytes(32).toString('base64') } as unknown as ConfigService),
      lifecycle as unknown as AgentLifecycleProducer,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  it('first contact creates an external agent named after the key; repeat calls update', async () => {
    const first = await service.touch(identity);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'external', apiKeyId: KEY, name: 'runner-1', orgId: ORG }),
    );
    expect(first.status).toBe('idle');

    await service.touch(identity);
    expect(repository.update).toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it('a held claim stamps working + currentTask; without one the agent is idle', async () => {
    repository.currentClaim!.mockResolvedValue({ id: TASK, title: 'Build the thing' });
    const working = await service.touch(identity);
    expect(working.status).toBe('working');
    expect(working.currentTaskId).toBe(TASK);
    expect(working.currentTaskTitle).toBe('Build the thing');

    repository.currentClaim!.mockResolvedValue(null);
    const idle = await service.touch(identity);
    expect(idle.status).toBe('idle');
    expect(idle.currentTaskId).toBeNull();
  });

  it('an (org, name) collision falls back to a key-suffixed name instead of failing', async () => {
    repository.create!
      .mockRejectedValueOnce({ code: '23505' })
      .mockImplementation((data: Record<string, unknown>) => row(data));
    const created = await service.touch(identity);
    expect(created.name).toBe(`runner-1-${KEY.slice(0, 6)}`);
  });

  it('silence past the offline threshold reads as offline whatever was stored', async () => {
    repository.listForOrg!.mockResolvedValue([
      row({
        status: 'working',
        lastSeenAt: new Date(Date.now() - AGENT_OFFLINE_AFTER_MS - 60_000),
        serverName: null,
        currentTaskTitle: null,
      }),
      row({ id: 'a2', name: 'fresh', status: 'working', serverName: null, currentTaskTitle: null }),
    ]);
    const { data } = await service.list(actor);
    expect(data[0]!.status).toBe('offline');
    expect(data[1]!.status).toBe('working');
  });

  it('no response ever carries the API key identity', async () => {
    repository.listForOrg!.mockResolvedValue([
      row({ serverName: null, currentTaskTitle: null }),
    ]);
    const flat = JSON.stringify([await service.touch(identity), await service.list(actor)]);
    expect(flat).not.toContain('apiKeyId');
    expect(flat).not.toContain(KEY);
  });

  // --- Managed lifecycle ---

  const createDto = { serverId: SERVER, name: 'runner-2' };

  it('createManaged mints a scoped key, seals it, and never serializes it back', async () => {
    const created = await service.createManaged(actor, createDto);
    expect(apiKeys.create).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ name: 'agent:runner-2', scopes: ['tasks:agent'] }),
    );
    const inserted = repository.create!.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted.kind).toBe('managed');
    expect(inserted.serverId).toBe(SERVER);
    expect(String(inserted.mcpKeyEnc)).toMatch(/^v1:/); // sealed, not plaintext
    const flat = JSON.stringify(created);
    expect(flat).not.toContain('sk_plaintext_secret');
    expect(flat).not.toContain('mcpKeyEnc');
  });

  it('refuses a server without the runner role', async () => {
    repository.findServer!.mockResolvedValue({ id: SERVER, orgId: ORG, name: 'box', roles: ['app'] });
    await expect(service.createManaged(actor, createDto)).rejects.toThrow(
      'agents.errors.serverNotRunner',
    );
  });

  it('a busy server needs the explicit confirm — a default, not a wall', async () => {
    repository.findManagedByServer!.mockResolvedValue([row({ kind: 'managed' })]);
    await expect(service.createManaged(actor, createDto)).rejects.toThrow(
      'agents.errors.serverBusy',
    );
    await expect(
      service.createManaged(actor, { ...createDto, confirmAdditional: true }),
    ).resolves.toBeDefined();
  });

  it('start flips to starting and enqueues; stop enqueues; external agents refuse both', async () => {
    stored = row({ kind: 'managed', status: 'stopped', serverName: null, currentTaskTitle: null });
    repository.listForOrg!.mockImplementation(() => [
      { ...(stored as object), serverName: null, currentTaskTitle: null },
    ]);
    await service.start(actor, { id: 'a1' });
    expect(repository.update).toHaveBeenCalledWith('a1', ORG, { status: 'starting' });
    expect(lifecycle.enqueue).toHaveBeenCalledWith({ agentId: 'a1', action: 'start' });

    await service.stop(actor, { id: 'a1' });
    expect(lifecycle.enqueue).toHaveBeenCalledWith({ agentId: 'a1', action: 'stop' });

    stored = row({ kind: 'external', serverName: null, currentTaskTitle: null });
    await expect(service.start(actor, { id: 'a1' })).rejects.toThrow('agents.errors.notManaged');
  });
});
