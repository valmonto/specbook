import type { Task } from '@pkg/contracts';
import { PlanShell } from './plan-shell';
import { PlanCanvasV2 } from './plan-canvas-v2';

/**
 * Plan v2: the draft-only dependency planner on a hand-rolled pointer/SVG canvas
 * (no React Flow, no dagre) ported from the preferred mockup. Shares its chrome
 * with Plan v1 via {@link PlanShell}; only the canvas surface differs. The page
 * swaps this in while `?view=plan2`.
 */
export function PlanModeV2({
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
        <PlanCanvasV2
          draftTasks={draftTasks}
          readOnly={readOnly}
          onOpenEditor={onOpenEditor}
          registerTidy={registerTidy}
        />
      )}
    </PlanShell>
  );
}
