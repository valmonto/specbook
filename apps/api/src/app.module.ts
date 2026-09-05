import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { DatabaseModule } from '@pkg/database';
import {
  ThrottlingModule,
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
import { AuthModule } from './auth/auth.module.js';
import { UserModule } from './user/user.module.js';
import { OrgModule } from './org/org.module.js';
import { JobsModule } from './jobs/index.js';
import { NotificationModule } from './notifications/index.js';
import { TasksModule } from './tasks/index.js';
import { ResearchModule } from './research/index.js';
import { ServerModule } from './servers/index.js';
import { EnvironmentModule } from './environments/index.js';
import { AgentModule } from './agents/index.js';
import { AttachmentsModule } from './attachments/index.js';
import { isProjectScopedIdentity } from '@pkg/contracts';
import type { SubjectResolvers } from './attachments/attachment.tokens.js';
import { TaskRepository } from './tasks/task.repository.js';
import { ApiKeyModule } from './api-key/index.js';
import { InvitationModule } from './invitations/index.js';
import { McpModule } from './mcp/index.js';
import { I18nModule } from './i18n/index.js';
import { SeedModule } from './seed/seed.module.js';
import { validateEnv } from './config/index.js';

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
      // Nest 12 dropped the deep `@nestjs/common/interfaces` export that
      // throttler's emitted types import, so under NodeNext `imports` stops
      // being optional (nestjs/throttler#2671). Harmless here; delete when
      // #2672 ships.
      imports: [],
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
            // Access check, not existence: a human MEMBER only reaches a task
            // whose project they were granted (the same scoped findById the
            // task surface uses); OWNER/ADMIN and agents pass unrestricted. This
            // is what closes the attachment leak on list, direct :id and read-url.
            task: async (subjectId, activeUser) =>
              (await tasks.findById(
                subjectId,
                activeUser.orgId,
                isProjectScopedIdentity(activeUser) ? activeUser.userId : undefined,
              )) !== null,
          };
        },
      },
    }),
    ApiKeyModule,
    InvitationModule,
    McpModule,
    SeedModule.forApp(),
    // LAST on purpose: the global throttler guard must be scanned after the
    // IAM guards so it keys by the verified user (see ThrottlingModule).
    ThrottlingModule,
  ],
  controllers: [],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggerErrorInterceptor },
  ],
})
export class AppModule {}
