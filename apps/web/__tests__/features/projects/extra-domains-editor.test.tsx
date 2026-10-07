import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExtraDomain } from '@pkg/contracts';
import {
  ExtraDomainsEditor,
  cleanExtraDomains,
} from '@/features/projects/components/extra-domains-editor';

function Harness({ initial = [], disabled }: { initial?: ExtraDomain[]; disabled?: boolean }) {
  const [value, setValue] = useState<ExtraDomain[]>(initial);
  return (
    <>
      <ExtraDomainsEditor idPrefix="t" value={value} onChange={setValue} disabled={disabled} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

const value = (): ExtraDomain[] =>
  JSON.parse(screen.getByTestId('value').textContent ?? '[]') as ExtraDomain[];

describe('ExtraDomainsEditor', () => {
  it('starts empty and adds a row that serves the web app by default', async () => {
    render(<Harness />);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'environments.extraDomainAdd' }));
    expect(value()).toEqual([{ domain: '', serves: 'web' }]);
  });

  it('edits the hostname and what it serves, and removes a row', async () => {
    render(<Harness initial={[{ domain: 'a.example.com', serves: 'web' }]} />);
    await userEvent.type(screen.getByRole('textbox'), 'x');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'api');
    expect(value()).toEqual([{ domain: 'a.example.comx', serves: 'api' }]);
    await userEvent.click(screen.getByRole('button', { name: 'environments.extraDomainRemove' }));
    expect(value()).toEqual([]);
  });

  /** Extra names hang off the main domain; with none there is nothing to add to. */
  it('cannot add a row while there is no main domain', () => {
    render(<Harness disabled />);
    expect(screen.getByRole('button', { name: 'environments.extraDomainAdd' })).toBeDisabled();
  });

  it('stops adding at the limit', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      domain: `h${i}.example.com`,
      serves: 'web' as const,
    }));
    render(<Harness initial={five} />);
    expect(screen.getByRole('button', { name: 'environments.extraDomainAdd' })).toBeDisabled();
  });
});

describe('cleanExtraDomains', () => {
  it('trims, lowercases and drops the rows left empty', () => {
    expect(
      cleanExtraDomains([
        { domain: '  App.Example.COM ', serves: 'api' },
        { domain: '   ', serves: 'web' },
      ]),
    ).toEqual([{ domain: 'app.example.com', serves: 'api' }]);
  });
});
