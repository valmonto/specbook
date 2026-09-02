/**
 * MCP tool scopes — what an API key may be granted, selected at key creation.
 *
 * Every MCP tool declares one scope; a key only ever sees the tools its
 * granted scopes cover. This is the exposure-control surface: creating a key
 * IS choosing which functions it can reach. Zod-free: ships to clients for
 * the key-creation UI.
 */
export const MCP_SCOPES = ['platform:read', 'orgs:read', 'tasks:agent', 'research:agent'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpToolDescriptor {
  readonly name: string;
  /** null = visible to every authenticated key (e.g. whoami). */
  readonly scope: McpScope | null;
  /** Org-scoped tools only exist for keys bound to an org (activeUser present). */
  readonly needsOrgContext?: boolean;
  readonly description: string;
}

/**
 * The canonical MCP tool metadata — the single source both sides read.
 * The server builds its catalog from these descriptors (McpTools attaches
 * schemas and handlers by name; a test asserts the 1:1 match both ways),
 * and the key-creation UI lists them per scope, so what the picker shows
 * cannot drift from what the server exposes.
 *
 * Consent consequence of scope-as-permission-unit: a tool added here under
 * an existing scope becomes reachable by every already-issued key holding
 * that scope.
 */
export const MCP_TOOLS = [
  {
    name: 'whoami',
    scope: null,
    description: 'This API key: its name and the scopes it was granted.',
  },
  {
    name: 'list_organizations',
    scope: 'orgs:read',
    description: 'Every organization on the platform, with member counts.',
  },
  {
    name: 'platform_stats',
    scope: 'platform:read',
    description: 'Platform totals (organization count).',
  },
  {
    name: 'list_projects',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Projects in this organization. Read a project (get_project) before working its tasks — its context document is the constitution.',
  },
  {
    name: 'get_project',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Full project: the context document (read it first), repo URL, default branch, and workdir on the agent machine.',
  },
  {
    name: 'get_repo_token',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "Mint a 1-hour GitHub token restricted to this project's bound repository (contents + pull requests) — clone/push with it, then let it expire. Requires the org's GitHub connection.",
  },
  {
    name: 'get_environment',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "A project's deploy environment(s) for diagnosis — the target server (name/host/ssh_user/port), deploy_path, domain, auto_deploy, and provisioning state (provision_status + provision_error). Read-only; NEVER returns secrets. Pass `name` (staging|production) to narrow to one.",
  },
  {
    name: 'list_deployments',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "Recent deployment runs across a project's environments, NEWEST FIRST — each run's trigger, status, phase, sha, domain, surfaced error and timestamps. Read-only diagnosis; triggering a deploy stays human-only.",
  },
  {
    name: 'list_tasks',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Tasks, filterable by project and status. available=true is THE work queue: ready and changes_requested tasks whose dependencies are all finished — pull from here. A changes_requested task was sent back or reopened: the latest human comments are the spec delta.',
  },
  {
    name: 'get_task',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Full task: spec (context, out-of-scope, acceptance criteria), the comment log, and dependency state.',
  },
  {
    name: 'create_task',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "File a task spec on the human's behalf. ALWAYS lands as a draft — only the human can dispatch it to ready (the dispatch gate), so use this to capture specs, not to queue work for yourself.",
  },
  {
    name: 'update_task',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "Edit a task's spec you captured — title, context, out-of-scope, area, acceptance criteria — on a DRAFT task, or an in_progress task you've claimed. Cannot change status, ownership, priority, or PR/branch links (use the transition / update_task_links tools). Org-scoped — the repair for a mistyped create_task.",
  },
  {
    name: 'claim_task',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Atomically claim a ready task (ready → in_progress). If another session won the race you get a conflict — pull the next available task instead.',
  },
  {
    name: 'update_status',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Move a task through the agent transitions: in_progress → blocked (comment = your question, required) or → needs_review (requires a summary comment AND branch + prUrl set on the task first, via update_task_links); blocked/changes_requested → in_progress to resume. One recovery edge: cancelled → done, for a completed no-code/research task the human cancelled that has no PR to reach done through review (the only → done an agent may make; the review path stays the human\'s).',
  },
  {
    name: 'update_task_links',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Record where the work lives: branch name and PR URL. Required before update_status → needs_review.',
  },
  {
    name: 'check_criterion',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Tick (or untick) one acceptance criterion by index as you complete it — this is live progress reporting.',
  },
  {
    name: 'set_assumption',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Flag a REVERSIBLE judgment call on a task you have claimed: record what you assumed, why it is the most defensible read, and how a human can verify it. Use this instead of blocking when the ambiguity is not discoverable but the call is safe to reverse (only a PR — no money, security, destructive migration, or external side-effect; those still hard-block). A flagged task keeps building but is held out of full-auto auto-merge — it waits for a human to review and clear the flag.',
  },
  {
    name: 'list_attachments',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "A task's files with presigned read URLs — fetch the bytes with a plain HTTP GET. Specs may carry design screenshots; read them before working.",
  },
  {
    name: 'create_attachment_upload',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Attach proof-of-work to a task, step 1 of 3: declares the file and returns a presigned PUT URL. Upload the bytes with HTTP PUT (Content-Type must match), then call confirm_attachment. Task policy applies (image/file only, size ceilings).',
  },
  {
    name: 'confirm_attachment',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Step 3: after the PUT succeeds, confirm — the server verifies what actually landed and the file becomes visible on the task.',
  },
  {
    name: 'add_comment',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "Write to the task's work log. kind 'progress' for narration mid-flight, 'comment' for everything else (questions go through update_status → blocked).",
  },
  {
    name: 'add_dependency',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "Add a 'depends on' edge: the task waits until the prerequisite reaches a terminal-success state (done) before it becomes claimable. Both tasks must be in the same project (and your org). Rejected if it would create a cycle or point a task at itself.",
  },
  {
    name: 'remove_dependency',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "Remove a 'depends on' edge between two tasks in your org — the dependent stops waiting on that prerequisite.",
  },
  // --- Research court: the agent conversation surface ---
  {
    name: 'list_research',
    scope: 'research:agent',
    needsOrgContext: true,
    description:
      'Research documents in this org. Defaults to the `researching` turn-queue (an agent turn is awaited — pull, read via get_research, reply with append_research_message). Pass `status` (researching | needs_review | accepted | all) and optional projectId to browse the fuller set.',
  },
  {
    name: 'get_research',
    scope: 'research:agent',
    needsOrgContext: true,
    description:
      'Full research document: its title, the current body (markdown) and version, its associated project (the default target when tickets are cut), and the message conversation so far.',
  },
  {
    name: 'append_research_message',
    scope: 'research:agent',
    needsOrgContext: true,
    description:
      'Reply into a research conversation AND publish a new draft: appends your message, replaces the document body with the markdown you pass, bumps the version, and moves the document to `needs_review` for the human. This is the research analogue of submitting for review.',
  },
  {
    name: 'heartbeat',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Announce liveness: upserts your agent row (identity = this API key), stamps last-seen and your current claim. Call between work cycles — a claim whose agent goes silent too long is released back to ready.',
  },
  {
    name: 'get_notes',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      "Read the human's pending steering notes on your claimed task — returning them STAMPS them as seen. Call at checkpoints (after claim, before opening the PR, before needs_review): the review gate refuses needs_review while an unread note exists. Claimant-only.",
  },
  {
    name: 'report_cost',
    scope: 'tasks:agent',
    needsOrgContext: true,
    description:
      'Report what your work on a claimed task cost so far. MEASURE, never estimate: run `node scripts/session-usage.mjs report <taskId>` (repo script) and pass its output — tokensIn is input + cache-write + cache-read (the input-class volume actually processed), tokensOut is output tokens. Values ADD to the running totals — report increments, not cumulative figures. usdCents only when you know your billing. Claimant-only: the key must hold the claim.',
  },
] as const satisfies readonly McpToolDescriptor[];

export type McpToolName = (typeof MCP_TOOLS)[number]['name'];

/** The tools granting exactly this scope exposes (unscoped tools excluded). */
export const mcpToolsForScope = (scope: McpScope): McpToolDescriptor[] =>
  MCP_TOOLS.filter((tool) => tool.scope === scope);

/**
 * Every tool a key holding these scopes can reach — unscoped tools included,
 * since they exist for every authenticated key.
 */
export const mcpToolsForScopes = (scopes: readonly McpScope[]): McpToolDescriptor[] =>
  MCP_TOOLS.filter((tool) => tool.scope === null || scopes.includes(tool.scope));
