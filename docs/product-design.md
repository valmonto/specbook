# Specbook — Product Design

Specbook is a spec/ticket tool built for agent-driven development: a human
plans and reviews, coding agents execute. This document is the design
constitution for the MVP — the data model, the status protocol, and the
reasoning behind both. When implementation and this document disagree, fix
one of them.

## The one loop that matters

```
human writes spec → agent pulls it → agent works → agent reports → human reviews
        ↑                                                              │
        └────────────────── feedback / acceptance ─────────────────────┘
```

Every feature must serve this loop. Anything that doesn't — sprints,
estimates, epics, burndowns, real-time collaboration — is deliberately out.
Generic trackers adapt to agents; specbook is shaped by them.

Two design principles fall out of the loop:

1. **The unit of work must be executable.** An agent needs to know exactly
   which node it picks up, works, and marks done. Unlimited task nesting
   destroys that — so the hierarchy is fixed and shallow, and sequencing is
   expressed with dependencies instead of depth.
2. **Status is a protocol, not a label.** Every status answers *whose move
   is it* — the human's or the agent's. That is what turns "review" and
   "feedback" from ceremony into a working loop.

## Data model

Five concepts. Org scoping, users, auth, and API keys come from the
valmatic platform and are not re-modeled here.

### Project

The container **and the brain**. Besides a name, its most important field
is `context`: a markdown document describing what the product is, the
stack, conventions, and hard boundaries. An agent reads it once at session
start — it is the CLAUDE.md of the product.

This is also where the human "maps out the whole idea": as prose vision,
not as hundreds of pre-created tasks. Deep task trees written on day one
are wrong by day three; a vision document absorbs that uncertainty, tasks
are cut from it just-in-time.

### Task

The unit of agent work, calibrated to one session / one PR. Structured
spec, not a freetext description box — agents fail on vague tickets, so
the tool makes vague tickets hard to *dispatch* (see the gates below):

| Field | Purpose |
| --- | --- |
| `title` | What, in one line |
| `context` | Why, plus pointers into the codebase |
| `out_of_scope` | The fence — what the agent must not touch |
| `acceptance_criteria` | jsonb checklist `[{text, done}]` — the definition of done |
| `status` | See the state machine below |
| `priority` | Ordering within the queue |
| `claimed_by`, `claimed_at` | Which agent session holds it, since when |
| `branch`, `pr_url` | Link to the work product — required at review time |

**Acceptance criteria replace subtasks.** Below the unit-of-work,
granularity is a checklist the agent ticks — "all boxes ticked" is a
machine-checkable definition of done, and ticked-count is progress
reporting for free. There is no `parent_id` in the MVP (see Cut list).

### Task dependency

`task_id → depends_on_task_id`. This is the autonomy engine. The core
agent query is:

> Give me tasks that are `ready` **and** have no unfinished dependencies.

The human plans by drawing arrows ("auth before uploads"); the agent
always pulls the next legal task without being told the order. Nesting
cannot express this — "build the API" and "build the UI" are not
parent/child, they are sequenced — dependencies can.

### Comment

The work log, typed:

| `kind` | Written by | Meaning |
| --- | --- | --- |
| `comment` | either | Ordinary discussion |
| `progress` | agent | Narration mid-flight ("migrations done, starting API layer") |
| `question` | agent | Blocking ambiguity — pairs with the `blocked` status |
| `answer` | human | Unblocks the question |

Comments carry `author_type` (user or agent, with the concrete user id /
API key id from IAM). Together with `status_changed_by` + timestamps on
every transition, this is the audit trail — when a review goes three
rounds, the history of who flipped what is on the record. Retrofitting
audit data is miserable; it ships from day one.

### Attachment (phase 2)

Screenshots and proof-of-work artifacts (e.g. ui-verifier output) attached
to comments. Deferred until storage is wired (rustfs, S3-compatible, runs
on the same VPS); until then, PR links carry proof-of-work.

## The status protocol

```
draft → ready → in_progress → needs_review → done
                   ↕︎              ↓
                blocked    changes_requested → in_progress (again)
```

Grouped by whose move it is:

**Human's court**

- `draft` — spec being written. Agents must not pull it. This state
  protects half-written ideas from eager agents.
- `blocked` — the agent hit ambiguity, posted a `question` comment, and
  stopped. Human answers and flips back to `ready` (or `in_progress`).
- `needs_review` — the agent claims done. Human accepts or pushes back.

**Agent's court**

- `ready` — the queue. The only state agents pull from, and only when no
  unfinished dependencies remain.
- `in_progress` — claimed by an agent session.
- `changes_requested` — **the feedback loop as a first-class state.** The
  human reviews, leaves comments on what is wrong, flips the task here; it
  re-enters the agent queue with the full prior context — spec, previous
  attempt, objections — attached. `needs_review → changes_requested →
  in_progress → needs_review` cycles as many times as needed, entirely on
  the record.

**Terminal**

- `done` — only the human can set it. The agent may claim completion,
  never accept its own work.
- `cancelled`.

**Progress is not a status.** There is no `50%` or `almost_done`. Coarse
status answers whose move it is; fine progress lives in ticked acceptance
criteria and `progress` comments.

### Transition rules (enforced in the service, not by convention)

| Actor | Allowed transitions |
| --- | --- |
| Agent (MCP key) | `ready→in_progress`, `in_progress→blocked`, `in_progress→needs_review`, `changes_requested→in_progress`, `blocked→in_progress` (after an answer) |
| Human | `draft→ready`, `blocked→ready`, `needs_review→done`, `needs_review→changes_requested`, any→`cancelled` |

Two gates make the protocol honest:

1. **Dispatch gate** — `draft→ready` requires `context` filled and at
   least one acceptance criterion. Capture is frictionless (a draft can be
   a bare title); only dispatching to agents is strict.
2. **Review gate** — `in_progress→needs_review` requires a summary comment
   (what changed, how it was verified) **and** `branch`/`pr_url` set. No
   silent "done" claims; review means: open task → click PR → check
   against acceptance criteria.

The state machine physically prevents the agent from approving itself.

### Claiming — the multi-agent reality

Several agent sessions run at once, so `ready→in_progress` is an **atomic
claim** recording `claimed_by` + `claimed_at`; a second caller gets a
clean "already claimed" instead of duplicate work.

The commoner failure is the quiet one: a session dies or is abandoned
mid-task, and the task sits `in_progress` forever, invisibly clogging the
queue. MVP answer: `claimed_at` makes staleness visible, and the UI offers
a claim reset. A heartbeat/lease can come later if manual reset proves
tiresome.

## MCP tools

The agent-facing API. MVP set:

| Tool | Purpose |
| --- | --- |
| `list_tasks` | The queue query — `ready`, unblocked, priority-ordered; also filters for other statuses |
| `get_task` | Full spec + comments + dependency state |
| `claim_task` | Atomic `ready→in_progress` |
| `update_status` | Guarded transitions (gates enforced server-side) |
| `add_comment` | Typed: `progress`, `question`, summary `comment` |
| `check_criterion` | Tick an acceptance-criteria box |

`ask_question` is `add_comment(kind: question)` + automatic flip to
`blocked` — the async Q&A channel between agent and human that generic
trackers lack.

## The human dashboard

The daily view is not a kanban of everything. It is **"your move"**:
tasks in `blocked` and `needs_review`. Everything else is agent territory
the human can ignore. The whole feedback loop reduces to one glanceable
list.

## Known limits and roadmap

- **Notifications** — the loop's throughput is bounded by human reaction
  time to `blocked`/`needs_review`, and the MVP assumes polling the
  dashboard. Roadmap: email/Telegram ping on any transition into the
  human's court. Bolt-on by design; nothing in the schema depends on it.
- **Attachments/screenshots** — phase 2, behind storage wiring (rustfs).
- **Umbrella tasks (`parent_id`, max depth 1)** — cut from MVP.
  Dependencies already express sequencing; hierarchy adds UI and
  auto-complete logic for little day-one value. Clean seam to add later.
- **Heartbeat/lease on claims** — if manual stale-claim reset proves
  tiresome.

## v2 — GitHub integration: specbook as the credential authority

The MVP treats the agent as the GitHub integration: it holds machine
credentials and reports `branch`/`pr_url` back as strings. v2 inverts
this — specbook provisions the workspace and the credentials, and the
agent machine holds **no standing GitHub credential at all**.

Mechanism: one **"Specbook" GitHub App** platform-wide. Each specbook
organization installs it on its own GitHub org (or personal account) —
the `installation_id` stored on the org is the tenancy boundary and is
not a secret. The App's private key is the single server-side secret in
the whole system (the one deliberate amendment to the no-secrets rule;
user tokens are still never stored).

**Status: the connection foundation is SHIPPED** — org settings has a
GitHub card (connect via App install redirect, granted-repo list,
disconnect), `/settings/github` consumes the install callback, and the
project form binds a project to a repo from the installation's grant
(`github_repo_id` on project; the server verifies the pick and derives
the URL). `GithubAppService` (apps/api/src/github/) is the single seam
that talks to GitHub; `GITHUB_APP_ID` / `GITHUB_APP_SLUG` /
`GITHUB_APP_PRIVATE_KEY` (base64 PEM) switch it on, `GITHUB_API_BASE`
lets tests point it at a stub.

**Step 1 (inbound webhook) is SHIPPED** — `POST /api/webhooks/github`
(HMAC over raw bytes, `GITHUB_WEBHOOK_SECRET`) acks fast and hands the
normalized event to a worker job; the worker resolves installation →
org → that org's projects on the event's repo → tasks by branch/PR URL,
and writes `pr_state`/`pr_number`/`ci_state` onto the task. The review
card and task detail render the live badges. Steps 2-3 remain open.

Delivered in three steps, each independently valuable:

1. **Inbound webhook → PR status on tasks.** GitHub pushes PR events;
   specbook annotates the linked task (open / merged / closed, CI
   state). Needs only a webhook signature secret. The review card shows
   live PR state instead of a dumb link.
2. **`get_repo_token` MCP tool** (behind `tasks:agent`). Mints a GitHub
   App installation token — **1-hour expiry, restricted to the
   project's repository, permissions Contents + Pull requests**. The
   agent clones, pushes and opens PRs with it; next session, fresh
   token. Kills long-lived PATs; a leaked token is one repo for one
   hour; an agent on project A physically cannot touch project B's
   repo. Org-bound API keys route minting through the right
   installation — the tenancy walls built in MVP extend to code.
3. **Repo provisioning on project create.** New project → specbook
   creates the repository in the connected GitHub org (optionally from
   the valmatic template), fills `repoUrl` itself. Template init
   (`init:project`) becomes the agent's first task on the fresh repo.

Scope guard: one specbook org ↔ one GitHub installation until a real
tenant needs more. The end state is the product pitch: *connect your
GitHub org, describe work, agents ship it through a review gate.*

## MVP build order

1. Migration + `@pkg/contracts` schemas (projects, tasks,
   task_dependencies, comments) with the status enum and gates.
2. Tasks service with the transition guard, tested.
3. MCP tools.
4. Web UI: project view, task list/detail, "your move" dashboard.
5. **Dogfood switch**: from here on, every specbook feature is built from
   a specbook task, by an agent, via MCP. The tool's own backlog is its
   first real project — and its best demo.
