import { Module } from '@nestjs/common';
import { SecretsModule, SshModule } from '@pkg/server';
import { EnvironmentModule } from '../environments/environment.module.js';
import { DataPlaneExecutor } from './data-plane.executor.js';

/**
 * The executors — the only path from an agent to an environment's data plane.
 * Real SSH happens here, in the api process, synchronously inside the MCP
 * call: a bounded read is short by construction (row caps, statement
 * timeouts, size caps), so it does not need the worker's job machinery.
 */
@Module({
  imports: [EnvironmentModule, SecretsModule, SshModule],
  providers: [DataPlaneExecutor],
  exports: [DataPlaneExecutor],
})
export class DataPlaneModule {}
