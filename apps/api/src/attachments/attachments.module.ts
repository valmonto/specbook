import {
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { AttachmentController } from './attachment.controller';
import { AttachmentRepository } from './attachment.repository';
import { AttachmentsService } from './attachments.service';
import { ATTACHMENT_SUBJECT_RESOLVERS } from './attachment.tokens';

import type { SubjectResolvers } from './attachment.tokens';

export interface AttachmentsModuleOptions {
  /** Modules whose exports the resolver factory needs (e.g. TasksModule). */
  imports?: ModuleMetadata['imports'];
  /** Builds the subjectType → existence-check map from injected services.
   *  Same (...args: unknown[]) convention as the other forRootAsync modules —
   *  narrow the injected services inside the factory. */
  resolvers: {
    inject?: (InjectionToken | OptionalFactoryDependency)[];
    useFactory: (...args: unknown[]) => SubjectResolvers | Promise<SubjectResolvers>;
  };
}

/**
 * Domain-blind by construction: this file names no feature module. The app's
 * composition root registers which subjects exist and how to verify them —
 * see app.module.ts for the wiring. A template app with no subjects yet
 * registers an empty map and adds entries as features land.
 */
@Module({})
export class AttachmentsModule {
  static register(options: AttachmentsModuleOptions): DynamicModule {
    return {
      module: AttachmentsModule,
      // Global like Storage/Database: registered once at the app root,
      // injectable by other feature modules (MCP tools wrap the service).
      global: true,
      imports: options.imports ?? [],
      controllers: [AttachmentController],
      providers: [
        AttachmentsService,
        AttachmentRepository,
        {
          provide: ATTACHMENT_SUBJECT_RESOLVERS,
          inject: options.resolvers.inject ?? [],
          useFactory: options.resolvers.useFactory,
        },
      ],
      exports: [AttachmentsService],
    };
  }
}
