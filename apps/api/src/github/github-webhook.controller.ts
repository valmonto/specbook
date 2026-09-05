import {
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { GithubWebhookProducer, InjectLogger, PinoLogger, PublicRoute } from '@pkg/server';
import { k } from '@pkg/locales';
import { normalizeGithubEvent } from './github-webhook.mapper.js';

/**
 * GitHub's delivery target — the repo's first unauthenticated non-health
 * route, so the shape is deliberate:
 *
 * - @PublicRoute skips the session guard chain; AUTH here is the HMAC: the
 *   signature over the RAW bytes, verified in constant time against
 *   GITHUB_WEBHOOK_SECRET. Unsigned/mismatched → 401, loudly logged.
 * - Unconfigured deploys 404 — the endpoint does not exist rather than
 *   existing and refusing (same philosophy as MCP scope filtering).
 * - Verified deliveries are normalized and enqueued; the handler never does
 *   the matching work itself, so GitHub gets its 202 in milliseconds.
 * - A payload we don't understand is acked and dropped (GitHub retries 5xx;
 *   there is nothing to retry about an event we don't consume). An enqueue
 *   failure (Redis down) DOES 500 — that is exactly when a retry helps.
 */
@Controller('webhooks/github')
export class GithubWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly producer: GithubWebhookProducer,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  @Post()
  @PublicRoute()
  // GitHub bursts on busy repos; budget per-IP well above the global default
  // window would allow for a session, but still bounded.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest<FastifyRequest>): Promise<{ ok: boolean }> {
    const secret = this.config.get<string>('GITHUB_WEBHOOK_SECRET');
    if (!secret) {
      throw new NotFoundException();
    }

    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !req.rawBody || !this.verify(req.rawBody, signature, secret)) {
      this.logger.warn(
        { ip: req.ip, event: req.headers['x-github-event'], hasSignature: Boolean(signature) },
        'GitHub webhook rejected: missing or invalid signature',
      );
      throw new UnauthorizedException(k.auth.errors.unauthorized);
    }

    const event = String(req.headers['x-github-event'] ?? '');
    const deliveryId = String(req.headers['x-github-delivery'] ?? randomUUID());

    const normalized = normalizeGithubEvent(event, req.body, deliveryId);
    if (!normalized) {
      this.logger.debug({ event, deliveryId }, 'GitHub webhook ignored: event not consumed');
      return { ok: true };
    }

    await this.producer.enqueue(normalized);
    return { ok: true };
  }

  private verify(raw: Buffer, signatureHeader: string, secret: string): boolean {
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
