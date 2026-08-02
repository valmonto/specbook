import { Module } from '@nestjs/common';
import { GithubAppService } from './github-app.service';

/**
 * The GitHub App seam as a shared module: the api uses it for connection,
 * provisioning, credential minting and the merge endpoint; the worker uses
 * it for auto-mode progression (merging on CI green). One seam, one place.
 */
@Module({
  providers: [GithubAppService],
  exports: [GithubAppService],
})
export class GithubAppModule {}
