import { createHmac } from 'node:crypto';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { GithubWebhookProducer } from '@pkg/server';
import { describe, expect, it, vi } from 'vitest';
import { GithubWebhookController } from '@/github/github-webhook.controller.js';
import { normalizeGithubEvent } from '@/github/github-webhook.mapper.js';

const SECRET = 'test-webhook-secret-0123456789';

const sign = (raw: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

const controllerWith = (secret?: string) => {
  const producer = { enqueue: vi.fn().mockResolvedValue({ id: 'job' }) };
  const config = { get: (key: string) => (key === 'GITHUB_WEBHOOK_SECRET' ? secret : undefined) };
  const controller = new GithubWebhookController(
    config as unknown as ConfigService,
    producer as unknown as GithubWebhookProducer,
    new FakeLogger().as<PinoLogger>(),
  );
  return { controller, producer };
};

const requestOf = (body: unknown, headers: Record<string, string>, rawOverride?: Buffer) => {
  const raw = rawOverride ?? Buffer.from(JSON.stringify(body));
  return { rawBody: raw, body, headers, ip: '1.2.3.4' } as never;
};

const prPayload = {
  installation: { id: 777 },
  repository: { full_name: 'valmonto/specbook' },
  pull_request: {
    number: 12,
    state: 'closed',
    merged: true,
    html_url: 'https://github.com/valmonto/specbook/pull/12',
    head: { ref: 'feat/x' },
  },
};

describe('GithubWebhookController', () => {
  it('404s when no webhook secret is configured — the endpoint does not exist', async () => {
    const { controller } = controllerWith(undefined);
    await expect(
      controller.receive(requestOf(prPayload, { 'x-hub-signature-256': 'sha256=whatever' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a missing signature', async () => {
    const { controller, producer } = controllerWith(SECRET);
    await expect(controller.receive(requestOf(prPayload, {}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(producer.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a signature made with the wrong secret', async () => {
    const { controller, producer } = controllerWith(SECRET);
    const raw = Buffer.from(JSON.stringify(prPayload));
    await expect(
      controller.receive(
        requestOf(prPayload, { 'x-hub-signature-256': sign(raw, 'wrong-secret') }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(producer.enqueue).not.toHaveBeenCalled();
  });

  it('verifies over the RAW bytes — a tampered body fails even with a valid-format header', async () => {
    const { controller } = controllerWith(SECRET);
    const signedRaw = Buffer.from(JSON.stringify(prPayload));
    const tampered = Buffer.from(JSON.stringify({ ...prPayload, installation: { id: 999 } }));
    await expect(
      controller.receive(
        requestOf(prPayload, { 'x-hub-signature-256': sign(signedRaw) }, tampered),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('acks and enqueues a correctly signed pull_request delivery', async () => {
    const { controller, producer } = controllerWith(SECRET);
    const raw = Buffer.from(JSON.stringify(prPayload));
    const res = await controller.receive(
      requestOf(prPayload, {
        'x-hub-signature-256': sign(raw),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-1',
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(producer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pull_request',
        deliveryId: 'delivery-1',
        installationId: 777,
        prState: 'merged',
      }),
    );
  });

  it('acks-and-drops an event it does not consume (no 5xx, no job)', async () => {
    const { controller, producer } = controllerWith(SECRET);
    const body = { installation: { id: 1 }, repository: { full_name: 'a/b' } };
    const raw = Buffer.from(JSON.stringify(body));
    const res = await controller.receive(
      requestOf(body, { 'x-hub-signature-256': sign(raw), 'x-github-event': 'star' }),
    );
    expect(res).toEqual({ ok: true });
    expect(producer.enqueue).not.toHaveBeenCalled();
  });
});

describe('normalizeGithubEvent', () => {
  it('maps PR object state: open / merged / closed', () => {
    const base = structuredClone(prPayload);
    base.pull_request.state = 'open';
    base.pull_request.merged = false;
    expect(normalizeGithubEvent('pull_request', base, 'd')).toMatchObject({ prState: 'open' });

    base.pull_request.state = 'closed';
    expect(normalizeGithubEvent('pull_request', base, 'd')).toMatchObject({ prState: 'closed' });

    base.pull_request.merged = true;
    expect(normalizeGithubEvent('pull_request', base, 'd')).toMatchObject({ prState: 'merged' });
  });

  it('carries the base branch so auto-deploy can gate on the default branch', () => {
    const withBase = structuredClone(prPayload) as { pull_request: Record<string, unknown> };
    withBase.pull_request.base = { ref: 'main' };
    expect(normalizeGithubEvent('pull_request', withBase, 'd')).toMatchObject({
      baseBranch: 'main',
    });
    const noBase = structuredClone(prPayload) as { pull_request: Record<string, unknown> };
    delete noBase.pull_request.base;
    // Defensive default: an absent base can never equal a default branch.
    expect(normalizeGithubEvent('pull_request', noBase, 'd')).toMatchObject({ baseBranch: '' });
  });

  it('maps workflow_run status/conclusion to ci state', () => {
    const run = (status: string, conclusion: string | null) => ({
      installation: { id: 777 },
      repository: { full_name: 'valmonto/specbook' },
      workflow_run: {
        head_branch: 'feat/x',
        status,
        conclusion,
        pull_requests: [{ number: 12 }],
      },
    });
    expect(normalizeGithubEvent('workflow_run', run('in_progress', null), 'd')).toMatchObject({
      ciState: 'pending',
    });
    expect(normalizeGithubEvent('workflow_run', run('completed', 'success'), 'd')).toMatchObject({
      ciState: 'passing',
      prNumbers: [12],
    });
    expect(normalizeGithubEvent('workflow_run', run('completed', 'failure'), 'd')).toMatchObject({
      ciState: 'failing',
    });
    // cancelled IS a verdict now — the classifier files it retryable, which
    // the auto-retry acts on instead of leaving the task pending forever.
    expect(normalizeGithubEvent('workflow_run', run('completed', 'cancelled'), 'd')).toMatchObject({
      ciState: 'failing',
    });
    expect(normalizeGithubEvent('workflow_run', run('completed', 'skipped'), 'd')).toMatchObject({
      ciState: 'pending',
    });
  });

  it('passes run id, head sha and raw conclusion through for the classifier', () => {
    const payload = {
      installation: { id: 777 },
      repository: { full_name: 'valmonto/specbook' },
      workflow_run: {
        id: 9001,
        head_branch: 'feat/x',
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'cancelled',
        pull_requests: [],
      },
    };
    expect(normalizeGithubEvent('workflow_run', payload, 'd')).toMatchObject({
      runId: 9001,
      headSha: 'abc123',
      runConclusion: 'cancelled',
    });
  });

  it('returns null for malformed or irrelevant payloads', () => {
    expect(normalizeGithubEvent('pull_request', null, 'd')).toBeNull();
    expect(normalizeGithubEvent('pull_request', { installation: { id: 1 } }, 'd')).toBeNull();
    expect(normalizeGithubEvent('push', structuredClone(prPayload), 'd')).toBeNull();
    expect(
      normalizeGithubEvent(
        'workflow_run',
        { installation: { id: 1 }, repository: { full_name: 'a/b' }, workflow_run: {} },
        'd',
      ),
    ).toBeNull();
  });
});
