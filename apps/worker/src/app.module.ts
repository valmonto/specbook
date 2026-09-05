import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '@pkg/database';
import {
  EventsModule,
  StorageModule,
  HealthModule,
  LoggerErrorInterceptor,
  LoggingModule,
  RedisModule,
  TelemetryModule,
} from '@pkg/server';
import { WorkerQueuesModule } from './queues/index.js';
import { validateEnv } from './config/index.js';

@Module({
  imports: [
    LoggingModule.forRoot({ singleLine: true }),
    TelemetryModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.getOrThrow<string>('DATABASE_URL'),
        maxConnections: config.get<number>('DATABASE_MAX_CONNECTIONS', 5),
      }),
    }),
    EventsModule,
    // Redis is the worker's only input — jobs arrive through it. Registering the
    // client here is what lets /health probe it: without it the check silently
    // skips Redis and a worker that cannot reach the queue reports healthy while
    // processing nothing.
    RedisModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (...args: unknown[]) => {
        const config = args[0] as ConfigService;
        return {
          endpoint: config.getOrThrow<string>('STORAGE_ENDPOINT'),
          region: config.getOrThrow<string>('STORAGE_REGION'),
          accessKeyId: config.getOrThrow<string>('STORAGE_ACCESS_KEY_ID'),
          secretAccessKey: config.getOrThrow<string>('STORAGE_SECRET_ACCESS_KEY'),
          bucket: config.getOrThrow<string>('STORAGE_BUCKET'),
        };
      },
    }),
    WorkerQueuesModule,
    HealthModule,
  ],
  controllers: [],
  providers: [{ provide: APP_INTERCEPTOR, useClass: LoggerErrorInterceptor }],
})
export class AppModule {}
