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

1. Over specbook MCP, `list_tasks` `status=in_progress` — agent-claimed
   count is ACTIVE.
2. `list_tasks` `available=true` — the ready queue, priority-ordered.
3. Queue empty or ACTIVE >= CAP → say one short line, wait, next sweep.
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
- Branch from fresh main. Implement. UI work is not done until driven in a
  real browser (playwright) with screenshots.
- `pnpm verify` must pass. Push the branch. `update_task_links` with the
  GitHub compare URL. Tick criteria honestly — only what is actually done.
- Upload verification screenshots to the ticket
  (`create_attachment_upload` + `confirm_attachment`).
- `needs_review` with an honest summary: what changed, how verified,
  anything the reviewer should know.

## Rejection and hard lines

- Spec unclear, contradictory, or infeasible → do NOT guess: transition to
  `blocked` with a precise question. That is rejection. Never abandon
  silently.
- Never touch `draft` tasks. Never transition to `ready` or `done` — the
  dispatch and acceptance gates are the human's, always.
