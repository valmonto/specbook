import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExtraDomain } from '@pkg/contracts';
import {
  ExtraDomainsEditor,
  cleanExtraDomains,
  describeExtraDomain,
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
  const add = () =>
    userEvent.click(screen.getByRole('button', { name: 'environments.extraDomainAdd' }));
  const app = () => screen.getByRole('combobox', { name: 'environments.extraDomainServes 1' });
  const withApi = () => screen.getByRole('checkbox', { name: 'environments.extraDomainWithApi 1' });

  it('starts empty and adds a row that shows the web app', async () => {
    render(<Harness />);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    await add();
    expect(value()).toEqual([{ domain: '', serves: 'web' }]);
    // The web app calls the api on its own address, so the box starts ticked.
    expect(withApi()).toBeChecked();
  });

  /** The repository decides which apps exist, so the name is typed, not picked. */
  it('takes any app name, and a landing page starts without the api', async () => {
    render(<Harness initial={[{ domain: 'example.com', serves: 'web' }]} />);
    await userEvent.clear(app());
    await userEvent.type(app(), 'landing');
    expect(value()).toEqual([{ domain: 'example.com', serves: 'landing' }]);
    expect(withApi()).not.toBeChecked();
  });

  it('records an explicit /api choice', async () => {
    render(<Harness initial={[{ domain: 'example.com', serves: 'landing' }]} />);
    await userEvent.click(withApi());
    expect(value()).toEqual([{ domain: 'example.com', serves: 'landing', withApi: true }]);
  });

  /** Another app has another default; the old tick must not ride along. */
  it('drops the /api choice when the app changes', async () => {
    render(<Harness initial={[{ domain: 'example.com', serves: 'landing', withApi: true }]} />);
    await userEvent.type(app(), 'x');
    expect(value()).toEqual([{ domain: 'example.com', serves: 'landingx' }]);
  });

  it('has nothing to choose for the api app: it is ticked and locked', () => {
    render(<Harness initial={[{ domain: 'app.example.com', serves: 'api' }]} />);
    expect(withApi()).toBeChecked();
    expect(withApi()).toBeDisabled();
  });

  it('removes a row', async () => {
    render(<Harness initial={[{ domain: 'a.example.com', serves: 'web' }]} />);
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
      serves: 'web',
    }));
    render(<Harness initial={five} />);
    expect(screen.getByRole('button', { name: 'environments.extraDomainAdd' })).toBeDisabled();
  });
});

describe('cleanExtraDomains', () => {
  it('trims, lowercases and drops the rows left empty', () => {
    expect(
      cleanExtraDomains([
        { domain: '  App.Example.COM ', serves: ' API ' },
        { domain: '   ', serves: 'web' },
      ]),
    ).toEqual([{ domain: 'app.example.com', serves: 'api' }]);
  });

  it('sends the /api choice only when one was made', () => {
    expect(
      cleanExtraDomains([
        { domain: 'a.example.com', serves: 'landing' },
        { domain: 'b.example.com', serves: 'landing', withApi: true },
        // Meaningless for the api app, so it is not sent at all.
        { domain: 'c.example.com', serves: 'api', withApi: false },
      ]),
    ).toEqual([
      { domain: 'a.example.com', serves: 'landing' },
      { domain: 'b.example.com', serves: 'landing', withApi: true },
      { domain: 'c.example.com', serves: 'api' },
    ]);
  });
});

describe('describeExtraDomain', () => {
  it('names the app, and says when the api rides along', () => {
    expect(describeExtraDomain({ domain: 'a.example.com', serves: 'api' })).toBe('api');
    expect(describeExtraDomain({ domain: 'a.example.com', serves: 'web' })).toBe('web + api');
    expect(describeExtraDomain({ domain: 'a.example.com', serves: 'landing' })).toBe('landing');
    expect(describeExtraDomain({ domain: 'a.example.com', serves: 'docs', withApi: true })).toBe(
      'docs + api',
    );
  });
});
