import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for values the database must hold but no API may
 * ever return: server SSH private keys today, environment secrets next.
 * AES-256-GCM under the deploy-wide APP_ENCRYPTION_KEY (32 bytes, base64).
 *
 * The sealed format is versioned — `v1:base64(iv | ciphertext | tag)` — so
 * a future key rotation or algorithm change can coexist with old blobs.
 */
@Injectable()
export class SecretsService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('APP_ENCRYPTION_KEY');
    if (!raw) {
      throw new Error('APP_ENCRYPTION_KEY is required (32 bytes, base64-encoded)');
    }
    this.key = Buffer.from(raw, 'base64');
    if (this.key.length !== 32) {
      throw new Error('APP_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${Buffer.concat([iv, encrypted, tag]).toString('base64')}`;
  }

  open(blob: string): string {
    if (!blob.startsWith('v1:')) {
      throw new Error('Unknown sealed-blob version');
    }
    const raw = Buffer.from(blob.slice(3), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const encrypted = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
