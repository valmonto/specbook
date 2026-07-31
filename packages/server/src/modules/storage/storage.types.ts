import type {
  DynamicModule,
  ForwardReference,
  InjectionToken,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';

export type StorageProvider = 's3';

export interface StorageModuleOptions {
  provider?: StorageProvider;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  corsAllowedOrigins?: string[];
}

export interface StorageModuleAsyncOptions {
  imports?: (DynamicModule | Type | ForwardReference | Promise<DynamicModule>)[];
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...args: unknown[]) => StorageModuleOptions | Promise<StorageModuleOptions>;
}

export interface StorageObjectInput {
  bucket?: string;
  key: string;
}

export interface CreateSignedUploadUrlInput extends StorageObjectInput {
  contentType?: string;
  expiresInSeconds?: number;
}

export interface CreateSignedReadUrlInput extends StorageObjectInput {
  expiresInSeconds?: number;
  /** Sets Content-Disposition on the response so downloads get a real name. */
  filename?: string;
  responseContentType?: string;
}

export interface HeadObjectResult {
  contentLength: number;
  contentType?: string;
}

export interface DeleteDirectoryInput {
  bucket?: string;
  prefix: string;
}

export interface SignedStorageUrl {
  bucket: string;
  key: string;
  url: string;
}
