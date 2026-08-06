import type { PinoLogger } from 'nestjs-pino';
import { AGENT_OFFLINE_AFTER_MS, type ActiveUser } from '@pkg/contracts';
import { FakeLogger } from '@pkg/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '@/agents/agent.service';
import type { AgentRepository } from '@/agents/agent.repository';

const ORG = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'ADMIN', systemRole: 'USER' };
const identity = { keyId: KEY, name: 'runner-1', activeUser: actor };

describe('AgentService — presence by API-key identity', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
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
    };
    service = new AgentService(
      repository as unknown as AgentRepository,
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
});
