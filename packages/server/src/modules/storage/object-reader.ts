import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * A READ-ONLY view onto one bucket with caller-supplied credentials — the
 * data-plane executor's storage seam. It deliberately exposes no put/delete:
 * an agent read window is a read window. The credentials live only for the
 * duration of the call and are never part of any result.
 */
export interface ObjectReaderOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export interface ObjectSummary {
  key: string;
  size: number | null;
  lastModified: string | null;
}

export interface ObjectHead {
  key: string;
  exists: boolean;
  size: number | null;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
}

export interface ObjectContent extends ObjectHead {
  /** 'text' when the body decoded as UTF-8 without loss, else 'base64'. */
  encoding: 'text' | 'base64';
  body: string;
}

export interface ObjectReader {
  list(prefix: string, maxKeys: number): Promise<{ objects: ObjectSummary[]; truncated: boolean }>;
  head(key: string): Promise<ObjectHead>;
  /** Rejects with `ObjectTooLargeError` when the object exceeds `maxBytes`. */
  get(key: string, maxBytes: number): Promise<ObjectContent>;
}

export class ObjectTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`object is ${size} bytes, cap is ${maxBytes}`);
  }
}

const isNotFound = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/** UTF-8 round-trips losslessly → text; anything else is handed back as base64. */
const encodeBody = (bytes: Uint8Array): { encoding: 'text' | 'base64'; body: string } => {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buffer)) {
    return { encoding: 'text', body: text };
  }
  return { encoding: 'base64', body: buffer.toString('base64') };
};

export function createObjectReader(options: ObjectReaderOptions): ObjectReader {
  const client = new S3Client({
    region: options.region ?? 'us-east-1',
    endpoint: options.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = options.bucket;

  return {
    async list(prefix, maxKeys) {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: maxKeys }),
      );
      return {
        objects: (out.Contents ?? []).map((o) => ({
          key: o.Key ?? '',
          size: o.Size ?? null,
          lastModified: o.LastModified?.toISOString() ?? null,
        })),
        truncated: Boolean(out.IsTruncated),
      };
    },

    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          key,
          exists: true,
          size: out.ContentLength ?? null,
          contentType: out.ContentType ?? null,
          lastModified: out.LastModified?.toISOString() ?? null,
          etag: out.ETag ?? null,
        };
      } catch (error) {
        if (isNotFound(error)) {
          return {
            key,
            exists: false,
            size: null,
            contentType: null,
            lastModified: null,
            etag: null,
          };
        }
        throw error;
      }
    },

    async get(key, maxBytes) {
      const head = await this.head(key);
      if (!head.exists) return { ...head, encoding: 'text', body: '' };
      if (head.size !== null && head.size > maxBytes) {
        throw new ObjectTooLargeError(head.size, maxBytes);
      }
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      const bytes = (await out.Body?.transformToByteArray()) ?? new Uint8Array();
      if (bytes.byteLength > maxBytes) throw new ObjectTooLargeError(bytes.byteLength, maxBytes);
      return { ...head, ...encodeBody(bytes) };
    },
  };
}
