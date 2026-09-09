import { Module } from '@nestjs/common';
import { SecretsModule, SshModule } from '@pkg/server';
import { ServerController } from './server.controller.js';
import { ServerService } from './server.service.js';
import { ServerRepository } from './server.repository.js';
import { ServerShellGateway } from './server-shell.gateway.js';
import { ServerShellRepository } from './server-shell.repository.js';
import { ServerShellService } from './server-shell.service.js';
import { EnvironmentRepository } from '../environments/environment.repository.js';

/**
 * The org's machine inventory for the deploy platform. Registration mints
 * credentials (SecretsModule seals them); reachability checks run in the
 * WORKER via the server-check queue.
 *
 * The one place this module DOES open a socket is the browser shell: a human
 * with `server:shell` (OWNER only) gets an interactive pty through the
 * gateway, audited and time-boxed. Nothing automated may use that path.
 */
@Module({
  imports: [SecretsModule, SshModule],
  controllers: [ServerController],
  providers: [
    ServerService,
    ServerRepository,
    EnvironmentRepository,
    ServerShellService,
    ServerShellRepository,
    ServerShellGateway,
  ],
  exports: [ServerService],
})
export class ServerModule {}
