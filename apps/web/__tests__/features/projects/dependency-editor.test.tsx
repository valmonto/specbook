import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { GetTaskByIdResponse } from '@pkg/contracts';
import { DependencyEditor } from '@/features/projects/components/dependency-editor';
import { render, screen, within } from '../../mocks/providers';
import { installRadixDomShims, makeAction, makeTask } from './helpers';

/**
 * The dependency editor's contract: it renders even with no edges, the picker
 * is a searchable typeahead over the project's NON-terminal tasks minus self
 * and already-linked ones, each candidate shows status + area, add/remove call
 * the hooks, and the server's cycle rejection shows inline. Hooks are mocked at
 * the module seam — a component-behavior test, not an API test.
 */

const hooks = vi.hoisted(() => ({
  useProjectTasks: vi.fn(),
  useAddDependency: vi.fn(),
  useRemoveDependency: vi.fn(),
}));

vi.mock('@/features/projects/hooks/use-projects', () => hooks);

const SELF = '11111111-1111-4111-8111-111111111111'; // makeTask()'s id
const LINKED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FREE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CANCELLED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

beforeAll(() => installRadixDomShims());

function detailTask(overrides: Partial<GetTaskByIdResponse> = {}): GetTaskByIdResponse {
  return {
    ...makeTask(),
    comments: [],
    dependencies: [],
    dependents: [],
    ...overrides,
  };
}

beforeEach(() => {
  hooks.useAddDependency.mockReturnValue(makeAction());
  hooks.useRemoveDependency.mockReturnValue(makeAction());
  hooks.useProjectTasks.mockReturnValue({
    data: {
      data: [
        makeTask({ id: SELF, title: 'Self', status: 'draft' }),
        makeTask({ id: LINKED, title: 'Already linked', status: 'ready' }),
        makeTask({ id: FREE, title: 'Free candidate', status: 'ready', area: 'web' }),
        makeTask({ id: OTHER, title: 'Other work', status: 'in_progress' }),
        makeTask({ id: DONE, title: 'Finished thing', status: 'done' }),
        makeTask({ id: CANCELLED, title: 'Scrapped thing', status: 'cancelled' }),
      ],
    },
  });
});

/** Open the typeahead popup and return its rendered options. */
async function openPicker() {
  await userEvent.click(screen.getByRole('combobox'));
  const listbox = await screen.findByRole('listbox');
  return within(listbox);
}

it('renders the section even when the task has no dependencies yet', () => {
  render(<DependencyEditor task={detailTask()} />);
  expect(screen.getByText('tasks.detail.dependencies')).toBeInTheDocument();
  expect(screen.getByText('tasks.detail.noDependencies')).toBeInTheDocument();
});

it('offers only non-terminal candidates — excludes self, linked, done, and cancelled', async () => {
  render(
    <DependencyEditor
      task={detailTask({
        dependencies: [{ id: LINKED, title: 'Already linked', status: 'ready' }],
      })}
    />,
  );
  const picker = await openPicker();
  expect(picker.getByText('Free candidate')).toBeInTheDocument();
  expect(picker.getByText('Other work')).toBeInTheDocument();
  expect(picker.queryByText('Self')).not.toBeInTheDocument();
  expect(picker.queryByText('Already linked')).not.toBeInTheDocument();
  expect(picker.queryByText('Finished thing')).not.toBeInTheDocument();
  expect(picker.queryByText('Scrapped thing')).not.toBeInTheDocument();
});

it('shows each candidate with a status badge and area chip', async () => {
  render(<DependencyEditor task={detailTask()} />);
  const picker = await openPicker();
  const free = picker.getByText('Free candidate').closest('[role="option"]')!;
  expect(within(free as HTMLElement).getByText('tasks.status.ready')).toBeInTheDocument();
  expect(within(free as HTMLElement).getByText('web')).toBeInTheDocument();
});

it('is a searchable typeahead: typing filters candidates by title', async () => {
  render(<DependencyEditor task={detailTask()} />);
  await userEvent.click(screen.getByRole('combobox'));
  await userEvent.type(screen.getByRole('combobox'), 'Free');
  const listbox = await screen.findByRole('listbox');
  expect(within(listbox).getByText('Free candidate')).toBeInTheDocument();
  expect(within(listbox).queryByText('Other work')).not.toBeInTheDocument();
});

it('adding a dependency selects a candidate and fires the hook', async () => {
  const add = makeAction();
  hooks.useAddDependency.mockReturnValue(add);
  render(<DependencyEditor task={detailTask()} />);

  const picker = await openPicker();
  await userEvent.click(picker.getByText('Free candidate'));
  await userEvent.click(screen.getByRole('button', { name: 'tasks.detail.addDependency' }));

  expect(add.execute).toHaveBeenCalledWith({ id: SELF, dependsOnTaskId: FREE });
});

it('shows an empty state when there are no eligible candidates', () => {
  hooks.useProjectTasks.mockReturnValue({
    data: {
      data: [
        makeTask({ id: SELF, title: 'Self', status: 'draft' }),
        makeTask({ id: DONE, title: 'Finished thing', status: 'done' }),
        makeTask({ id: CANCELLED, title: 'Scrapped thing', status: 'cancelled' }),
      ],
    },
  });
  render(<DependencyEditor task={detailTask()} />);
  expect(screen.getByText('tasks.detail.dependencyEmpty')).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

it('each existing dependency has a remove control that fires the hook', async () => {
  const remove = makeAction();
  hooks.useRemoveDependency.mockReturnValue(remove);
  render(
    <DependencyEditor
      task={detailTask({
        dependencies: [{ id: LINKED, title: 'Already linked', status: 'done' }],
      })}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'tasks.detail.removeDependency' }));
  expect(remove.execute).toHaveBeenCalledWith({ id: SELF, dependsOnTaskId: LINKED });
});

it('surfaces the server cycle rejection inline instead of failing silently', () => {
  hooks.useAddDependency.mockReturnValue({
    ...makeAction(),
    error: new Error('tasks.errors.dependencyCycle'),
  });
  render(<DependencyEditor task={detailTask()} />);
  expect(screen.getByText('tasks.errors.dependencyCycle')).toBeInTheDocument();
});

it('offers no editing controls on a terminal task', () => {
  render(<DependencyEditor task={detailTask({ status: 'done' })} />);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'tasks.detail.addDependency' }),
  ).not.toBeInTheDocument();
});
