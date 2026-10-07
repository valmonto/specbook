import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { EXTRA_DOMAIN_SERVES, MAX_EXTRA_DOMAINS, type ExtraDomain } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

/**
 * The extra hostnames of an environment: more names for the same stack, each
 * saying what it answers with. Optional — an environment with one name never
 * touches this.
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
  const servesLabel = {
    web: t(k.environments.extraDomainServesWeb),
    api: t(k.environments.extraDomainServesApi),
  } as const;

  const patch = (index: number, change: Partial<ExtraDomain>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...change } : row)));

  return (
    <div className="space-y-1.5">
      <Label>{t(k.environments.extraDomains)}</Label>
      {value.map((row, index) => (
        // Index keys on purpose: a row has no identity but its position while
        // its hostname is still being typed.
        // eslint-disable-next-line react/no-array-index-key
        <div key={index} className="flex items-center gap-2">
          <Input
            id={`${idPrefix}-extra-domain-${index}`}
            aria-label={`${t(k.environments.extraDomains)} ${index + 1}`}
            value={row.domain}
            onChange={(e) => patch(index, { domain: e.target.value })}
            placeholder="api.example.com"
            className="min-w-0 flex-1 font-mono"
          />
          <NativeSelect
            aria-label={t(k.environments.extraDomainServes)}
            value={row.serves}
            onChange={(e) => patch(index, { serves: e.target.value as ExtraDomain['serves'] })}
          >
            {EXTRA_DOMAIN_SERVES.map((serves) => (
              <NativeSelectOption key={serves} value={serves}>
                {servesLabel[serves]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
      ))}
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

/** What a form sends: trimmed, lowercased, and without the rows left empty. */
export function cleanExtraDomains(rows: ExtraDomain[]): ExtraDomain[] {
  return rows
    .map((row) => ({ domain: row.domain.trim().toLowerCase(), serves: row.serves }))
    .filter((row) => row.domain.length > 0);
}
