import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks';
import { TaskRepository } from '../tasks/task.repository';
import { AttachmentController } from './attachment.controller';
import { AttachmentRepository } from './attachment.repository';
import { AttachmentsService } from './attachments.service';
import { ATTACHMENT_SUBJECT_RESOLVERS, type SubjectResolvers } from './attachment.tokens';

/**
 * The attachments core is domain-blind; this module is where the app tells
 * it which subjects exist. Adding a subject type = one line here plus the
 * value in ATTACHMENT_SUBJECT_TYPES.
 */
@Module({
  imports: [TasksModule],
  controllers: [AttachmentController],
  providers: [
    AttachmentsService,
    AttachmentRepository,
    {
      provide: ATTACHMENT_SUBJECT_RESOLVERS,
      inject: [TaskRepository],
      useFactory: (tasks: TaskRepository): SubjectResolvers => ({
        task: async (subjectId, orgId) => (await tasks.findById(subjectId, orgId)) !== null,
      }),
    },
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
