import { Module } from '@nestjs/common';
import { SshService } from './ssh.service.js';

/** Agentless SSH seam — real connections happen only in the worker. */
@Module({
  providers: [SshService],
  exports: [SshService],
})
export class SshModule {}
