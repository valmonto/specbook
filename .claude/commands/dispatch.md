---
description: Run the specbook agent runner — sweeps the ready queue every 5 minutes until stopped
---

# Specbook agent runner

Config (edit here, it's versioned):

- CADENCE: 300 seconds between sweeps
- CAP: 3 concurrent claimed tasks
- MODE: loop (run `/dispatch once` for a single sweep)

You are the specbook agent runner. Unless invoked with `once`, loop forever:
sweep → wait CADENCE (run `sleep 300` in Bash — do not busy-poll) → sweep
again. The human stops you by interrupting or closing the session; never
stop on your own just because sweeps keep coming back empty.

## One sweep

1. Call `heartbeat` — this stamps your agent row (presence) so the board
   shows you alive and your claims are never mistaken for a dead runner's.
   Every other MCP call also stamps implicitly, but a quiet sweep with no
   other calls still needs this one. A claim whose agent stays silent past
   the stale threshold (30 min) is auto-released back to ready.
2. `list_tasks` `status=in_progress` — agent-claimed count is ACTIVE.
3. `list_tasks` `available=true` — the work queue, priority-ordered. It
   serves `ready` tasks AND `changes_requested` ones (review rejections and
   reopened done tasks): for those, read the task's latest human comments
   first — they are the spec delta for this round.
4. Queue empty or ACTIVE >= CAP → say one short line, wait, next sweep.
   Otherwise claim up to `CAP - ACTIVE` tasks. One: work inline. Several:
   one subagent per task, isolated git worktrees, per-slot ports
   (api 3001/3002/3003, vite 5174/5175/5176).

## Protocol per task (non-negotiable)

- Read the ticket AND its attachments first (`list_attachments`; images are
  visual specs — download via readUrl and look at them).
- Repo access: if the project is repo-bound (`githubRepoFullName` set on
  `get_project`), call `get_repo_token` with the projectId and clone/push
  via the returned `cloneUrl` — the token is repo-scoped and dies in an
  hour, so re-mint rather than store it. Machine SSH credentials remain
  the fallback for unbound projects.
- Call `get_notes` at three checkpoints: right after claiming, before
  opening the PR, and before `update_status` → `needs_review`. It returns
  the human's steering notes and marks them seen — act on what it says.
  The review gate hard-rejects `needs_review` while an unread note exists.
- Right after claiming, snapshot your measured usage:
  `node scripts/session-usage.mjs baseline <taskId>`. Never estimate
  tokens — your own transcript is the ground truth and estimates are off
  by orders of magnitude.
- Branch from fresh main. Implement. UI work is not done until driven in a
  real browser (playwright) with screenshots.
- `pnpm verify` must pass. Push the branch. `update_task_links` with the
  GitHub compare URL. Tick criteria honestly — only what is actually done.
- Upload verification screenshots to the ticket
  (`create_attachment_upload` + `confirm_attachment`).
- `needs_review` with an honest summary: what changed, how verified,
  anything the reviewer should know. Carry your MEASURED cost on the same
  call: run `node scripts/session-usage.mjs report <taskId>` and pass its
  `tokensIn`/`tokensOut` to `update_status` (`costTokensIn`/`costTokensOut`)
  or `report_cost`. tokensIn folds cache reads/writes in — that is the
  input-class volume actually processed. If the output says
  `"baseline": "missing"` (session restarted mid-task), still report but
  say so in the summary — the figure is whole-session, an over-attribution.
  Leave `costUsdCents` unset on subscription billing. Claimant-only,
  values ADD — never re-report a running total.

## Rejection and hard lines

- Spec unclear, contradictory, or infeasible → do NOT guess: transition to
  `blocked` with a precise question. That is rejection. Never abandon
  silently.
- Never touch `draft` tasks. Never transition to `ready`, `approved` or
  `done` — the dispatch, review and merge gates are the human's, always.
- An empty `available` queue can also mean the merge-debt gate: a project
  holding 3 `approved` (merged-pending) tasks stops feeding the queue until
  the human merges. Nothing for you to do there — just wait.
