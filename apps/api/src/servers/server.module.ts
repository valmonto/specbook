import { Module } from '@nestjs/common';
import { SecretsModule } from '@pkg/server';
import { ServerController } from './server.controller.js';
import { ServerService } from './server.service.js';
import { ServerRepository } from './server.repository.js';
import { EnvironmentRepository } from '../environments/environment.repository.js';

/**
 * The org's machine inventory for the deploy platform. Registration mints
 * credentials (SecretsModule seals them); reachability checks run in the
 * WORKER via the server-check queue — this module never opens a socket.
 */
@Module({
  imports: [SecretsModule],
  controllers: [ServerController],
  providers: [ServerService, ServerRepository, EnvironmentRepository],
  exports: [ServerService],
})
export class ServerModule {}
