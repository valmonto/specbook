import { useState } from 'react';
import type { AttachmentKind, ListAttachmentsResponse } from '@pkg/contracts';
import { attachmentKindAllowed, attachmentLimitFor } from '@pkg/contracts';
import { useAuth } from '@/shared/auth/auth-context';
import { useCachedRequest } from '@/shared/hooks/use-cached-request';
import { useCan } from '@/shared/hooks/use-permissions';
import { projectsApi } from '../api';

const kindOf = (file: File): AttachmentKind => {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
};

export function useTaskAttachments(taskId: string | null) {
  const { user } = useAuth();
  const canList = useCan('attachment:list');
  const key =
    canList && taskId && user?.orgId ? `org:${user.orgId}/attachments/task/${taskId}` : null;

  return useCachedRequest<ListAttachmentsResponse>({
    key,
    fetcher: () => projectsApi.listAttachments({ subjectType: 'task', subjectId: taskId! }),
  });
}

/**
 * The client side of the three-step protocol: declare, PUT the bytes
 * straight to storage against the presigned URL, confirm. The row only
 * becomes visible after the server verifies what actually landed.
 */
export function useUploadAttachment(onDone: () => Promise<unknown> | void) {
  const [isUploading, setUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const upload = async (taskId: string, file: File): Promise<boolean> => {
    setUploading(true);
    setError(null);
    try {
      const kind = kindOf(file);
      if (!attachmentKindAllowed('task', kind)) {
        throw new Error('attachments.errors.kindNotAllowed');
      }
      if (file.size > attachmentLimitFor('task', kind)) {
        throw new Error('attachments.errors.tooLarge');
      }
      const declared = await projectsApi.createAttachmentUpload({
        subjectType: 'task',
        subjectId: taskId,
        kind,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        withThumbnail: false,
      });
      const put = await fetch(declared.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!put.ok) throw new Error('attachments.errors.uploadFailed');
      await projectsApi.confirmAttachment({ id: declared.attachment.id });
      await onDone();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e : new Error('attachments.errors.uploadFailed'));
      return false;
    } finally {
      setUploading(false);
    }
  };

  return { upload, isUploading, error };
}

export function useDeleteAttachment(onDone: () => Promise<unknown> | void) {
  const [isDeleting, setDeleting] = useState(false);

  const remove = async (id: string): Promise<void> => {
    setDeleting(true);
    try {
      await projectsApi.removeAttachment({ id });
      await onDone();
    } finally {
      setDeleting(false);
    }
  };

  return { remove, isDeleting };
}
