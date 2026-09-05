import { Module } from '@nestjs/common';
import { SecretsModule } from '@pkg/server';
import { EnvironmentController } from './environment.controller.js';
import { EnvironmentService } from './environment.service.js';
import { EnvironmentRepository } from './environment.repository.js';

@Module({
  imports: [SecretsModule],
  controllers: [EnvironmentController],
  providers: [EnvironmentService, EnvironmentRepository],
  exports: [EnvironmentService, EnvironmentRepository],
})
export class EnvironmentModule {}
