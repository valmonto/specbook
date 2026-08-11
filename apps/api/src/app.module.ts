import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { DatabaseModule } from '@pkg/database';
import {
  AppThrottlerGuard,
  StorageModule,
  EventsModule,
  GlobalExceptionFilter,
  HealthModule,
  IAM_REDIS,
  LoggerErrorInterceptor,
  LoggingModule,
  TelemetryModule,
  ThrottlerRedisStorage,
} from '@pkg/server';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { OrgModule } from './org/org.module';
import { JobsModule } from './jobs';
import { NotificationModule } from './notifications';
import { TasksModule } from './tasks';
import { ResearchModule } from './research';
import { ServerModule } from './servers';
import { EnvironmentModule } from './environments';
import { AgentModule } from './agents';
import { AttachmentsModule } from './attachments';
import type { SubjectResolvers } from './attachments/attachment.tokens';
import { TaskRepository } from './tasks/task.repository';
import { ApiKeyModule } from './api-key';
import { McpModule } from './mcp';
import { I18nModule } from './i18n';
import { SeedModule } from './seed/seed.module';
import { validateEnv } from './config';

@Module({
  imports: [
    LoggingModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.getOrThrow<string>('DATABASE_URL'),
        maxConnections: config.get<number>('DATABASE_MAX_CONNECTIONS', 10),
      }),
    }),
    TelemetryModule,
    // Rate limiting: a global default budget per verified user (per IP when
    // unauthenticated), Redis-backed so limits hold across replicas and
    // restarts. Routes override with @Throttle({ default: { limit, ttl } })
    // and opt out with @SkipThrottle() — the health endpoint does. Limiter
    // Redis is the IAM one unless RATE_LIMIT_REDIS_HOST points elsewhere;
    // counters are namespaced and ephemeral, so switching migrates nothing.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, IAM_REDIS],
      useFactory: (config: ConfigService, iamRedis: Redis) => {
        const dedicatedHost = config.get<string>('RATE_LIMIT_REDIS_HOST');
        const redis = dedicatedHost
          ? new Redis({
              host: dedicatedHost,
              port: config.get<number>('RATE_LIMIT_REDIS_PORT', 6379),
              password: config.get<string>('RATE_LIMIT_REDIS_PASSWORD'),
            })
          : iamRedis;

        return {
          throttlers: [
            {
              name: 'default',
              limit: config.get<number>('RATE_LIMIT_MAX', 300),
              ttl: config.get<number>('RATE_LIMIT_WINDOW_MS', 60_000),
              // Off under test so suites never fight the limiter.
              skipIf: () => config.get<string>('NODE_ENV') === 'test',
            },
          ],
          storage: new ThrottlerRedisStorage(redis),
        };
      },
    }),
    EventsModule,
    I18nModule,
    HealthModule,
    AuthModule,
    UserModule,
    OrgModule,
    JobsModule,
    NotificationModule,
    TasksModule,
    ResearchModule,
    ServerModule,
    EnvironmentModule,
    AgentModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      // Options factory is typed (...args: unknown[]) — narrow inside.
      useFactory: (...args: unknown[]) => {
        const config = args[0] as ConfigService;
        return {
          endpoint: config.getOrThrow<string>('STORAGE_ENDPOINT'),
          region: config.getOrThrow<string>('STORAGE_REGION'),
          accessKeyId: config.getOrThrow<string>('STORAGE_ACCESS_KEY_ID'),
          secretAccessKey: config.getOrThrow<string>('STORAGE_SECRET_ACCESS_KEY'),
          bucket: config.getOrThrow<string>('STORAGE_BUCKET'),
          corsAllowedOrigins: config
            .getOrThrow<string>('STORAGE_CORS_ALLOWED_ORIGINS')
            .split(',')
            .map((origin: string) => origin.trim()),
        };
      },
    }),
    // Attachments are domain-blind; the app registers its subjects here.
    AttachmentsModule.register({
      imports: [TasksModule],
      resolvers: {
        inject: [TaskRepository],
        useFactory: (...args: unknown[]): SubjectResolvers => {
          const tasks = args[0] as TaskRepository;
          return {
            task: async (subjectId, orgId) => (await tasks.findById(subjectId, orgId)) !== null,
          };
        },
      },
    }),
    ApiKeyModule,
    McpModule,
    SeedModule.forApp(),
  ],
  controllers: [],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggerErrorInterceptor },
    // Runs after the auth chain (imported modules register their guards
    // first), so the tracker keys by VERIFIED userId — and a 429 still fires
    // before any handler or bcrypt work.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
