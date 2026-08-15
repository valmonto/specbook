import { ReactFlowProvider } from '@xyflow/react';
import type { Task } from '@pkg/contracts';
import { PlanShell } from './plan-shell';
import { PlanCanvas } from './plan-canvas';

/**
 * Plan v1: the draft-only dependency planner on a React Flow + dagre canvas
 * (lanes per area, edges = dependencies). Shares its chrome with Plan v2 via
 * {@link PlanShell}; only the canvas surface differs. The page swaps this in
 * while `?view=plan`.
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
        <ReactFlowProvider>
          <PlanCanvas
            draftTasks={draftTasks}
            readOnly={readOnly}
            onOpenEditor={onOpenEditor}
            registerTidy={registerTidy}
          />
        </ReactFlowProvider>
      )}
    </PlanShell>
  );
}
