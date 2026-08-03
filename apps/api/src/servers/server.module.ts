import { Module } from '@nestjs/common';
import { SecretsModule } from '@pkg/server';
import { ServerController } from './server.controller';
import { ServerService } from './server.service';
import { ServerRepository } from './server.repository';

/**
 * The org's machine inventory for the deploy platform. Registration mints
 * credentials (SecretsModule seals them); reachability checks run in the
 * WORKER via the server-check queue — this module never opens a socket.
 */
@Module({
  imports: [SecretsModule],
  controllers: [ServerController],
  providers: [ServerService, ServerRepository],
  exports: [ServerService],
})
export class ServerModule {}
