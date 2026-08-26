import { useTranslation } from 'react-i18next';
import { k } from '@pkg/locales';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Confirm dialog for the stranded-work recovery move (draft → done): a task
 * whose PR merged out-of-band never travelled the review arc, so the owner
 * records the truth directly. `done` skips review, so it is deliberately a
 * confirmed step rather than a one-click button. Controlled — the caller owns
 * `open` and fires `onConfirm` on accept.
 */
export function MarkDoneDialog({
  open,
  onOpenChange,
  isLoading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(k.tasks.markDoneConfirm.title)}</AlertDialogTitle>
          <AlertDialogDescription>{t(k.tasks.markDoneConfirm.body)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t(k.common.actions.cancel)}</AlertDialogCancel>
          <AlertDialogAction disabled={isLoading} onClick={onConfirm}>
            {t(k.tasks.markDoneConfirm.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
