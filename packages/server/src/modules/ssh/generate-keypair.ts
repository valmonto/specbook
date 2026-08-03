import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface GeneratedSshKeypair {
  /** One-line `ssh-ed25519 AAAA… comment` for authorized_keys. */
  publicKey: string;
  /** Unencrypted OpenSSH private key — the format ssh clients (and ssh2) parse. */
  privateKey: string;
}

const str = (b: Buffer): Buffer => Buffer.concat([u32(b.length), b]);
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/**
 * ed25519 keypair in the two formats SSH actually speaks. Node's crypto can
 * only export PKCS8/SPKI, which OpenSSH tooling (and the ssh2 client) do not
 * accept for ed25519 — so the raw 32-byte halves are extracted from the DER
 * (both are its trailing 32 bytes) and re-wrapped in the openssh-key-v1
 * container ourselves. Round-tripped against ssh-keygen in tests.
 */
export function generateSshKeypair(comment: string): GeneratedSshKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32);
  const seed = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32);

  const keyType = Buffer.from('ssh-ed25519');
  const pubBlob = Buffer.concat([str(keyType), str(pubRaw)]);

  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    str(keyType),
    str(pubRaw),
    str(Buffer.concat([seed, pubRaw])), // OpenSSH stores seed||pub as the "private" scalar
    str(Buffer.from(comment)),
  ]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);

  const container = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    str(Buffer.from('none')), // cipher
    str(Buffer.from('none')), // kdf
    str(Buffer.alloc(0)), // kdf options
    u32(1),
    str(pubBlob),
    str(priv),
  ]);
  const b64 = container.toString('base64').replace(/(.{70})/g, '$1\n');

  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END OPENSSH PRIVATE KEY-----\n`,
  };
}
