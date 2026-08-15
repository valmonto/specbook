import type { Task } from '@pkg/contracts';
import { PlanShell } from './plan-shell';
import { PlanCanvas } from './plan-canvas';

/**
 * Plan — the draft-only dependency planner on a hand-rolled pointer/SVG canvas
 * (no React Flow, no dagre) ported from the preferred mockup. {@link PlanShell}
 * supplies the shared chrome (note, Tidy/New, legend); this only wires the
 * canvas surface. The page swaps this in while `?view=plan`.
 */
export function PlanMode({
  projectId,
  tasks,
  readOnly,
  onOpenEditor,
}: {
  projectId: string;
  /** The full project task set; Plan mode scopes itself to the drafts. */
  tasks: Task[];
  readOnly: boolean;
  onOpenEditor: (task: Task) => void;
}) {
  return (
    <PlanShell projectId={projectId} tasks={tasks} readOnly={readOnly}>
      {({ draftTasks, registerTidy }) => (
        <PlanCanvas
          draftTasks={draftTasks}
          readOnly={readOnly}
          onOpenEditor={onOpenEditor}
          registerTidy={registerTidy}
        />
      )}
    </PlanShell>
  );
}
