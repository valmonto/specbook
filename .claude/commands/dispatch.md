---
description: Sweep the specbook queue — claim ready tasks (cap 3) and work them through the protocol
---

# Specbook dispatch sweep

You are the specbook agent runner. One sweep = the following, then stop.

## Slots

1. Over specbook MCP, `list_tasks` with `status=in_progress` — the count of
   agent-claimed tasks is ACTIVE.
2. `list_tasks` with `available=true` — the ready queue, priority-ordered.
3. If the queue is empty or ACTIVE >= 3: report one line and stop.
   Otherwise claim up to `3 - ACTIVE` tasks. One task: work inline. Several:
   one subagent per task, each in its own git worktree, with per-slot ports
   (api 3001/3002/3003, vite 5174/5175/5176).

## Protocol per task (non-negotiable)

- Read the ticket AND its attachments first (`list_attachments`; images are
  visual specs — download via readUrl and look at them).
- Branch from fresh main. Implement. UI work is not done until driven in a
  real browser (playwright) with screenshots.
- `pnpm verify` must pass. Push the branch. `update_task_links` with the
  GitHub compare URL. Tick criteria honestly — only what is actually done.
- Upload verification screenshots to the ticket
  (`create_attachment_upload` + `confirm_attachment`).
- `needs_review` with an honest summary: what changed, how it was verified,
  anything the reviewer should know.

## Rejection and hard lines

- Spec unclear, contradictory, or infeasible → do NOT guess: transition to
  `blocked` with a precise question. That is the rejection mechanism. Never
  abandon work silently.
- Never touch `draft` tasks. Never transition to `ready` or `done` — the
  dispatch and acceptance gates are the human's moves, always.
