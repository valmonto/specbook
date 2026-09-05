import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, Loader2, Paperclip, Plus, Trash2 } from 'lucide-react';
import type { AttachmentWithUrls } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { cn } from '@/shared/lib/utils';
import {
  useDeleteAttachment,
  useTaskAttachments,
  useUploadAttachment,
} from '../hooks/use-attachments';
import { AttachmentGalleryDialog } from './attachment-gallery-dialog';

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentTile({
  item,
  onOpen,
  onDelete,
  deleting,
}: {
  item: AttachmentWithUrls;
  onOpen: () => void;
  /** Absent in read-only views — the delete affordance is not rendered. */
  onDelete?: () => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const { attachment, readUrl } = item;
  const isImage = attachment.kind === 'image';

  return (
    <div className="group relative overflow-hidden rounded-lg border bg-card">
      {/* Opens the gallery — never a download; the gallery holds the one
          explicit Download action. */}
      {isImage ? (
        <button type="button" onClick={onOpen} className="block w-full cursor-zoom-in">
          <img
            src={readUrl}
            alt={attachment.fileName ?? 'attachment'}
            className="h-24 w-full object-cover"
          />
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex h-24 w-full flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground"
          title={t(k.attachments.title)}
        >
          <FileText className="size-6" />
          <Download className="size-3.5" />
        </button>
      )}
      <div className="flex items-center gap-1 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {attachment.fileName ?? attachment.mimeType} · {prettySize(attachment.sizeBytes)}
        </span>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive pointer-coarse:opacity-100"
            aria-label={t(k.common.actions.delete)}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Proof-of-work lives here: screenshots and files on a task, uploaded
 * straight to object storage via presigned URLs (the API never touches the
 * bytes) and only visible once the server has verified the upload.
 *
 * The whole section is a drop target: empty, it renders as one dashed
 * drop-zone; with files, a ghost "+" tile joins the grid. Both open the
 * picker on click.
 */
export function AttachmentsSection({
  taskId,
  readOnly = false,
}: {
  taskId: string;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { data, mutate } = useTaskAttachments(taskId);
  const uploadCtl = useUploadAttachment(() => mutate());
  const deleteCtl = useDeleteAttachment(() => mutate());
  const fileInput = useRef<HTMLInputElement>(null);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const items = data?.data ?? [];

  const uploadFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      await uploadCtl.upload(taskId, file);
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void uploadFiles(e.dataTransfer.files);
    },
  };

  return (
    <section className="space-y-2" {...dropProps}>
      <h4 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Paperclip className="size-3.5" />
        {t(k.attachments.title)}
        {uploadCtl.isUploading && <Loader2 className="size-3.5 animate-spin" />}
      </h4>

      {items.length === 0 ? (
        readOnly ? null : (
          <button
            type="button"
            disabled={uploadCtl.isUploading}
            onClick={() => fileInput.current?.click()}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground',
              dragging && 'border-primary/60 bg-primary/5 text-foreground',
            )}
          >
            <Plus className="size-4" />
            {t(k.attachments.dropHint)}
          </button>
        )
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {items.map((item, itemIndex) => (
            <AttachmentTile
              key={item.attachment.id}
              item={item}
              deleting={deleteCtl.isDeleting}
              onOpen={() => setGalleryIndex(itemIndex)}
              onDelete={readOnly ? undefined : () => void deleteCtl.remove(item.attachment.id)}
            />
          ))}
          {readOnly ? null : (
            <button
              type="button"
              disabled={uploadCtl.isUploading}
              onClick={() => fileInput.current?.click()}
              aria-label={t(k.attachments.add)}
              title={t(k.attachments.dropHint)}
              className={cn(
                'flex min-h-24 items-center justify-center rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground',
                dragging && 'border-primary/60 bg-primary/5',
              )}
            >
              {uploadCtl.isUploading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <Plus className="size-5" />
              )}
            </button>
          )}
        </div>
      )}

      <AttachmentGalleryDialog
        items={items}
        index={galleryIndex}
        onClose={() => setGalleryIndex(null)}
        onSelect={setGalleryIndex}
      />

      {uploadCtl.error && <p className="text-sm text-destructive">{t(uploadCtl.error.message)}</p>}

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void uploadFiles(e.target.files)}
      />
    </section>
  );
}
