import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { InjectLogger, PinoLogger } from '@pkg/server';
import { k } from '@pkg/locales';
import type {
  ActiveUser,
  ApiKey,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  McpScope,
} from '@pkg/contracts';
import type { ApiKeyRow } from '@pkg/database';
import { ApiKeyRepository } from './api-key.repository';

const hash = (key: string): string => createHash('sha256').update(key).digest('hex');

const toView = (row: ApiKeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: row.scopes as McpScope[],
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly repository: ApiKeyRepository,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  /**
   * Mint a key. The scopes chosen here ARE the exposure decision — the MCP
   * server will only ever show this key the tools those scopes cover. The
   * plaintext is returned once and never stored; only its hash is kept.
   */
  async create(creator: ActiveUser, dto: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
    const key = `sk_${randomBytes(24).toString('base64url')}`;

    const row = await this.repository.insert({
      name: dto.name,
      prefix: key.slice(0, 10),
      hashedKey: hash(key),
      scopes: [...new Set(dto.scopes)],
      userId: creator.userId,
      // The key is bound to the org it was minted in: org-scoped MCP tools
      // act as this user inside this org, never anywhere else.
      orgId: creator.orgId,
    });

    this.logger.info(
      { keyId: row.id, scopes: row.scopes, createdBy: creator.userId, orgId: creator.orgId },
      'API key created',
    );

    return { ...toView(row), key };
  }

  async list(): Promise<ListApiKeysResponse> {
    const rows = await this.repository.listActive();
    return { data: rows.map(toView) };
  }

  async revoke(id: string): Promise<void> {
    const revoked = await this.repository.revoke(id);
    if (!revoked) {
      throw new NotFoundException(k.mcp.errors.keyNotFound);
    }
    this.logger.info({ keyId: id }, 'API key revoked');
  }

  /**
   * Presented token → its scopes plus, for org-bound keys, the ActiveUser the
   * key acts as. Org standing is re-read on every verify, so a user removed
   * from the org loses the key's org powers immediately. A key whose owner
   * lost membership degrades to platform scopes only (activeUser null) rather
   * than dying — the org-scoped tools simply vanish for it.
   */
  async verify(token: string): Promise<{
    keyId: string;
    name: string;
    scopes: McpScope[];
    activeUser: ActiveUser | null;
  } | null> {
    const row = await this.repository.findActiveByHash(hash(token));
    if (!row) return null;

    // Fire-and-forget: a failed timestamp must never fail an auth check. But we
    // log the rejection rather than swallow it — this stamp silently no-op'd for
    // months once, and silence is what hid it.
    this.repository.touchLastUsed(row.id).catch((err: unknown) => {
      this.logger.warn({ err, keyId: row.id }, 'failed to stamp API key last_used_at');
    });

    let activeUser: ActiveUser | null = null;
    if (row.orgId) {
      const standing = await this.repository.findOrgStanding(row.userId, row.orgId);
      if (standing) {
        activeUser = {
          userId: row.userId,
          orgId: row.orgId,
          orgRole: standing.orgRole as ActiveUser['orgRole'],
          systemRole: standing.systemRole as ActiveUser['systemRole'],
          // A machine identity. This is what keeps the dispatch runner (and any
          // agent) org-wide even when the key's owner is a MEMBER: the
          // project-visibility layer scopes humans only, never agents.
          isAgent: true,
        };
      }
    }

    return { keyId: row.id, name: row.name, scopes: row.scopes as McpScope[], activeUser };
  }
}
