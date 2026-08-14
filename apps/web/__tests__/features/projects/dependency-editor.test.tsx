import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { GetTaskByIdResponse } from '@pkg/contracts';
import { DependencyEditor } from '@/features/projects/components/dependency-editor';
import { render, screen } from '../../mocks/providers';
import { makeAction, makeTask } from './helpers';

/**
 * The dependency editor's contract: it renders even with no edges, the picker
 * is the project's other tasks minus self and already-linked ones, add/remove
 * call the hooks, and the server's cycle rejection shows inline. Hooks are
 * mocked at the module seam — a component-behavior test, not an API test.
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
        makeTask({ id: SELF, title: 'Self' }),
        makeTask({ id: LINKED, title: 'Already linked' }),
        makeTask({ id: FREE, title: 'Free candidate' }),
      ],
    },
  });
});

it('renders the section even when the task has no dependencies yet', () => {
  render(<DependencyEditor task={detailTask()} />);
  expect(screen.getByText('tasks.detail.dependencies')).toBeInTheDocument();
  expect(screen.getByText('tasks.detail.noDependencies')).toBeInTheDocument();
});

it('the picker excludes self and already-linked tasks', () => {
  render(
    <DependencyEditor
      task={detailTask({
        dependencies: [{ id: LINKED, title: 'Already linked', status: 'ready' }],
      })}
    />,
  );
  const options = screen.getByLabelText('tasks.detail.dependencyPlaceholder');
  expect(options).toHaveTextContent('Free candidate');
  expect(options).not.toHaveTextContent('Self');
  expect(options).not.toHaveTextContent('Already linked');
});

it('adding a dependency selects a candidate and fires the hook', async () => {
  const add = makeAction();
  hooks.useAddDependency.mockReturnValue(add);
  render(<DependencyEditor task={detailTask()} />);

  await userEvent.selectOptions(
    screen.getByLabelText('tasks.detail.dependencyPlaceholder'),
    FREE,
  );
  await userEvent.click(screen.getByRole('button', { name: 'tasks.detail.addDependency' }));

  expect(add.execute).toHaveBeenCalledWith({ id: SELF, dependsOnTaskId: FREE });
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
  expect(
    screen.queryByLabelText('tasks.detail.dependencyPlaceholder'),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'tasks.detail.addDependency' }),
  ).not.toBeInTheDocument();
});
