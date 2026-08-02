import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { PipelineStrip } from '@/features/projects/components/v2/pipeline-strip';
import { render, screen } from '../../mocks/providers';

describe('PipelineStrip', () => {
  it('renders the always-on stages with counts and the merge-debt cap', () => {
    render(
      <PipelineStrip counts={{ ready: 2, approved: 3 }} selected="ready" onSelect={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /tasks\.status\.ready2/ })).toBeInTheDocument();
    // Approved always shows its cap denominator.
    expect(screen.getByRole('button', { name: /tasks\.status\.approved3\/3/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tasks\.status\.done0/ })).toBeInTheDocument();
  });

  it('hides rare stages at zero and shows them when occupied', () => {
    const { rerender } = render(
      <PipelineStrip counts={{}} selected="ready" onSelect={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /tasks\.status\.blocked/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /tasks\.status\.changes_requested/ }),
    ).not.toBeInTheDocument();

    rerender(
      <PipelineStrip
        counts={{ blocked: 1, changes_requested: 2 }}
        selected="ready"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /tasks\.status\.blocked1/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /tasks\.status\.changes_requested2/ }),
    ).toBeInTheDocument();
  });

  it('marks the selected stage pressed and reports clicks', async () => {
    const onSelect = vi.fn();
    render(<PipelineStrip counts={{ needs_review: 1 }} selected="needs_review" onSelect={onSelect} />);

    expect(screen.getByRole('button', { name: /tasks\.status\.needs_review/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: /tasks\.status\.done/ }));
    expect(onSelect).toHaveBeenCalledWith('done');
  });
});
