import { Module } from '@nestjs/common';
import { SecretsService } from './secrets.service.js';

/** App-level encryption seam — sealed values are write-only by design. */
@Module({
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
