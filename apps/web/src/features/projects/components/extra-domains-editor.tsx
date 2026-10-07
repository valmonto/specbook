import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import {
  MAX_EXTRA_DOMAINS,
  SUGGESTED_APP_NAMES,
  routesApi,
  type ExtraDomain,
} from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The extra hostnames of an environment: more names for the same stack, each
 * pointing at one app from the repository. Optional — an environment with one
 * name never touches this.
 *
 * The app is typed, not picked from a fixed list: the repository decides which
 * apps exist (`apps/<name>/Dockerfile`), and specbook only learns that at
 * build time. The suggestions cover the usual ones; a name with no Dockerfile
 * fails the build saying so.
 *
 * Rows are edited in place and half-typed rows are allowed; `cleanExtraDomains`
 * decides what is actually sent.
 */
export function ExtraDomainsEditor({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  value: ExtraDomain[];
  onChange: (next: ExtraDomain[]) => void;
  /** No main domain: extra names have nothing to hang off. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const suggestions = `${idPrefix}-app-suggestions`;

  const replace = (index: number, row: ExtraDomain) =>
    onChange(value.map((old, i) => (i === index ? row : old)));

  return (
    <div className="space-y-1.5">
      <Label>{t(k.environments.extraDomains)}</Label>
      <datalist id={suggestions}>
        {SUGGESTED_APP_NAMES.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {value.map((row, index) => {
        const apiOnly = row.serves.trim() === 'api';
        return (
          // Index keys on purpose: a row has no identity but its position
          // while its hostname is still being typed.
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input
              id={`${idPrefix}-extra-domain-${index}`}
              aria-label={`${t(k.environments.extraDomains)} ${index + 1}`}
              value={row.domain}
              onChange={(e) => replace(index, { ...row, domain: e.target.value })}
              placeholder="www.example.com"
              className="min-w-40 flex-1 font-mono"
            />
            <Input
              aria-label={`${t(k.environments.extraDomainServes)} ${index + 1}`}
              value={row.serves}
              // Another app has another default for /api, so the old answer is
              // dropped with it rather than carried over silently.
              onChange={(e) => replace(index, { domain: row.domain, serves: e.target.value })}
              list={suggestions}
              placeholder="web"
              className="w-28 font-mono"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                aria-label={`${t(k.environments.extraDomainWithApi)} ${index + 1}`}
                // The api app answers the api by definition; there is nothing to choose.
                disabled={apiOnly}
                checked={routesApi({ serves: row.serves.trim(), withApi: row.withApi })}
                onCheckedChange={(checked) => replace(index, { ...row, withApi: checked === true })}
              />
              {t(k.environments.extraDomainWithApi)}
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t(k.environments.extraDomainRemove)}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || value.length >= MAX_EXTRA_DOMAINS}
        onClick={() => onChange([...value, { domain: '', serves: 'web' }])}
      >
        <Plus className="size-4" />
        {t(k.environments.extraDomainAdd)}
      </Button>
      <p className="text-xs text-muted-foreground">{t(k.environments.extraDomainsHint)}</p>
    </div>
  );
}

/**
 * What a form sends: trimmed, lowercased, and without the rows left empty.
 * `withApi` is sent only when it was actually chosen, so an untouched row
 * keeps following its app's default.
 */
export function cleanExtraDomains(rows: ExtraDomain[]): ExtraDomain[] {
  return rows
    .map((row) => {
      const serves = row.serves.trim().toLowerCase();
      return {
        domain: row.domain.trim().toLowerCase(),
        serves,
        ...(row.withApi !== undefined && serves !== 'api' ? { withApi: row.withApi } : {}),
      };
    })
    .filter((row) => row.domain.length > 0);
}

/** How a hostname reads on the environment card: its app, and "+ api" when it carries the api too. */
export function describeExtraDomain(row: ExtraDomain): string {
  if (row.serves === 'api') return 'api';
  return routesApi(row) ? `${row.serves} + api` : row.serves;
}
