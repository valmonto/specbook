import { Module } from '@nestjs/common';
import { SecretsModule } from '@pkg/server';
import { EnvironmentController } from './environment.controller';
import { EnvironmentService } from './environment.service';
import { EnvironmentRepository } from './environment.repository';

@Module({
  imports: [SecretsModule],
  controllers: [EnvironmentController],
  providers: [EnvironmentService, EnvironmentRepository],
  exports: [EnvironmentService],
})
export class EnvironmentModule {}
