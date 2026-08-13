import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { k } from '@pkg/locales';
import { Input } from '@/components/ui/input';

/**
 * The board's title search — orthogonal to the pipeline strip's status filter,
 * and the only survivor of the old filter bar (the redundant "Show" status
 * chips were folded into the strip). State lives in the URL via the page (?q),
 * so it survives reloads and is shareable; this component is a pure view over
 * that state.
 */

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
}

export function TaskSearch({ query, onQueryChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label={t(k.tasks.filter.searchLabel)}
        placeholder={t(k.tasks.filter.searchPlaceholder)}
        className="h-8 pl-8 text-[13px]"
      />
    </div>
  );
}
