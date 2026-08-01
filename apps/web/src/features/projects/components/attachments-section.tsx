import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, Loader2, Paperclip, Plus, Trash2 } from 'lucide-react';
import type { AttachmentWithUrls } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import {
  useDeleteAttachment,
  useTaskAttachments,
  useUploadAttachment,
} from '../hooks/use-attachments';

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentTile({
  item,
  onDelete,
  deleting,
}: {
  item: AttachmentWithUrls;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const { attachment, readUrl } = item;
  const isImage = attachment.kind === 'image';

  return (
    <div className="group relative overflow-hidden rounded-lg border bg-card">
      {isImage ? (
        <a href={readUrl} target="_blank" rel="noreferrer">
          <img
            src={readUrl}
            alt={attachment.fileName ?? 'attachment'}
            className="h-24 w-full object-cover"
          />
        </a>
      ) : (
        <a
          href={readUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-24 w-full flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground"
          title={t(k.attachments.download)}
        >
          <FileText className="size-6" />
          <Download className="size-3.5" />
        </a>
      )}
      <div className="flex items-center gap-1 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {attachment.fileName ?? attachment.mimeType} · {prettySize(attachment.sizeBytes)}
        </span>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
          aria-label={t(k.common.actions.delete)}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Proof-of-work lives here: screenshots and files on a task, uploaded
 * straight to object storage via presigned URLs (the API never touches the
 * bytes) and only visible once the server has verified the upload.
 */
export function AttachmentsSection({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const { data, mutate } = useTaskAttachments(taskId);
  const uploadCtl = useUploadAttachment(() => mutate());
  const deleteCtl = useDeleteAttachment(() => mutate());
  const fileInput = useRef<HTMLInputElement>(null);

  const items = data?.data ?? [];

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      await uploadCtl.upload(taskId, file);
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Paperclip className="size-3.5" />
        {t(k.attachments.title)}
      </h4>

      {items.length === 0 && !uploadCtl.isUploading && (
        <p className="text-sm text-muted-foreground">{t(k.attachments.empty)}</p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <AttachmentTile
            key={item.attachment.id}
            item={item}
            deleting={deleteCtl.isDeleting}
            onDelete={() => void deleteCtl.remove(item.attachment.id)}
          />
        ))}
      </div>

      {uploadCtl.error && (
        <p className="text-sm text-destructive">{t(uploadCtl.error.message)}</p>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void onPick(e.target.files)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={uploadCtl.isUploading}
        onClick={() => fileInput.current?.click()}
      >
        {uploadCtl.isUploading ? (
          <Loader2 className="size-4 mr-1 animate-spin" />
        ) : (
          <Plus className="size-4 mr-1" />
        )}
        {t(uploadCtl.isUploading ? k.attachments.uploading : k.attachments.add)}
      </Button>
    </section>
  );
}
