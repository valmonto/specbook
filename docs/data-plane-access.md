# Agent access to an environment's data plane

How an agent gets to read a project environment's **Postgres, Redis and
object storage** while debugging — and why it usually cannot.

## The model in one line

**Default denied. A human opens a window. It closes by itself. Every call is
audited. The executors enforce all of it.**

Until this feature, an agent that broke a staging deploy was debugging blind:
it could read the deploy record (`list_deployments`) and the environment's
shape (`get_environment`), but not the running state — is the migration
applied, is the queue backed up, is the file in the bucket. The only route was
a human SSHing in and pasting output back. This is the first MCP surface that
touches APPLICATION data rather than specbook's own records; the line is
crossed once, deliberately, with a grant and an audit trail.

## The grant lives on the environment

`project_environment` carries the window:

| Column              | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `mcp_access`        | `none` (default) · `read` · `write` (reserved, see below)              |
| `mcp_access_until`  | when the window closes; checked against the clock on **every** call    |
| `mcp_access_by`     | who opened it (`SET NULL` if that user goes; the audit keeps the name) |
| `mcp_access_reason` | recorded reason — mandatory for production                             |

Environment, not project, is the grain: staging and production are not the
same risk, and every audit line stays self-describing ("agent X read
`bot_trade` on solmond·staging at 14:32, grant expires 15:00").

**Expiry is the clock's.** `effectiveMcpAccess()` (`apps/api/src/environments/mcp-access.ts`)
is the one place that decides what a row means _now_: a window whose `until`
has passed IS `none`, with every companion field null, in the executor, in the
API shape and in the UI. Nothing needs to clear it; nothing the agent sends can
revive it. Every existing environment was `none` after the migration — shipping
the feature opened nothing.

**There is no extend.** An open window must be revoked before another is
opened; a lapsed one is simply re-granted. Each window is a decision someone
made.

## Opening a window — the human door

`POST /api/projects/:projectId/environments/:id/mcp-access` (`project:update`),
or the **Agent data access** panel inside an environment on the project page.

| Environment  | Longest window | Default | Louder confirmation                                           |
| ------------ | -------------- | ------- | ------------------------------------------------------------- |
| `staging`    | 240 min        | 60 min  | —                                                             |
| `production` | 30 min         | 15 min  | a **reason** is mandatory AND the name must be **typed back** |

Production is allowed — that was the owner's decision, over a structural ban —
but the door is deliberately louder: the panel shows a red warning, the form
cannot submit until the reason is written and `production` is typed, the
ceiling is a fraction of staging's, and the service refuses the request if
either is missing (`mcpAccessReasonRequired`, `mcpAccessConfirmRequired`).
The choice is documented where it is enforced: `EnvironmentService.grantMcpAccess`
and `MCP_ACCESS_CONFIRMATION_REQUIRED` in `@pkg/contracts`.

`DELETE …/mcp-access` closes the window immediately (also audited). Lapsing
needs no action.

Only `read` is grantable today. `write` exists in the vocabulary so a later PR
can add it as a **separate decision** (shorter default window, recorded
reason) — legitimate for dropping a stuck job or clearing a poisoned key, but
not "the same checkbox one column over". The grant API refuses it with
`mcpAccessWriteUnsupported`.

## Executors — the only path

```
MCP tool  →  DataPlaneExecutor  →  grant check  →  bounded remote op  →  scrub  →  audit
```

`apps/api/src/data-plane/data-plane.executor.ts` is the single place that
talks to an environment's data plane, and the same place that checks the
grant. Policy is enforced in the executor, never in the tool: a fourth tool
added later cannot bypass it, because there is nothing else to call — a test
proves that any request shape without a live grant is denied and audited.

Per resource, the executor SSHes to the server that **hosts that role**
(placement-aware — a moved database is read on the database server) and runs
one named remote op from `remote-ops.ts`; ad-hoc command strings never cross
the wire:

| Resource   | Op                                                              | Bound                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database` | `data-plane-read-sql` — one `SELECT`/`WITH`/`EXPLAIN`/`SHOW`    | runs **as the unit's own role** (no superuser, reaches only its database), `default_transaction_read_only=on`, `statement_timeout` 5 s, wrapped in `LIMIT` (cap 200 rows), one statement, no comments    |
| `cache`    | `data-plane-read-redis` — `GET` `EXISTS` `TYPE` `TTL` `SCAN`    | values capped at 64 KiB, `SCAN` one page per call (≤ 200 keys), password via `REDISCLI_AUTH` on stdin — never argv                                                                                       |
| `storage`  | S3 `list` / `head` / `get` through the environment's own `S3_*` | list ≤ 200 keys, objects ≤ 1 MiB (text inline, binary as base64); credentials opened server-side for the call only — there is no platform-provisioned bucket per environment yet, so no `S3_*` = no read |

**Not execution.** No shell, no arbitrary DDL, no schema changes. Agents ingest
task text, PR comments and web pages — anything carrying text can carry an
instruction. A bounded read on a granted environment is contained; the
controlled path for changing state already exists: a deploy, where it is
reviewable.

**Sealed values never leave.** The executors never return credentials by
construction (no `platform_env`, no `user_env_enc`, no keys), and as a second
layer every string in a result — and every remote error — is scrubbed against
the environment's own secret material (user env values, the unit's database
password, the cache password) before it reaches the agent or the audit.
`apps/api/__tests__/data-plane/data-plane.executor.test.ts` asserts it.

## The audit

`data_access_audit`: one append-only row per executor call (`allowed`,
`denied`, `failed`) and per human grant/revoke — org, environment, **project
and environment names snapshotted**, the calling key and agent name, the task
(passed by the agent or taken from its current claim), the human behind a
grant, resource, operation, target (the statement / key / object), outcome,
detail, duration. The environment link is `SET NULL` so the audit outlives a
deleted environment; the org scopes the read.

Humans read it at `GET …/mcp-access/audit` and in the panel's **Show audit**.
No MCP tool exposes it — agents cannot read the log of their own access.

## The MCP surface

A new scope, **`data-plane:agent`**, gates three tools; an ordinary
`tasks:agent` key never sees them. The scope says WHICH keys may ever ask; the
grant says WHEN.

| Tool                 | Reads                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| `data_plane_sql`     | one bounded statement → `{ rows, rowCount, capped, cap }`                      |
| `data_plane_cache`   | `get` `exists` `type` `ttl` on a key, or one `scan` page on a pattern          |
| `data_plane_storage` | `list` a prefix, `head` a key, `get` a key (text inline / base64, size-capped) |

Every result carries `environment` and `grantExpiresAt`. A remote failure
(bad table name, unreachable box) comes back as `{ ok: false, error }` so the
agent can correct itself; a missing grant is a hard refusal
(`environments.errors.mcpAccessDenied`). `get_environment` now also reports
`mcpAccess` / `mcpAccessUntil`, so an agent can see whether a window is open
before asking.

## Assumption: staging holds non-production data

This model makes **arbitrary reads** on a granted environment defensible
because the control is the window and the log, not a guessed-at list of safe
query shapes. That is a small feature when staging holds seeded or synthetic
data — which is what specbook's staging is: the seed plus whatever the dev
loop produces on it. **If a staging environment ever holds a copy of
production data, the fix is the data, not this tool.** Production windows exist
for incidents, behind the louder door, and are short.

## Debt, honestly

- `write` windows are not grantable (vocabulary only) — a deliberate second PR.
- Storage reads need the environment's own `S3_*` user vars; per-environment
  bucket provisioning is still the follow-up noted in
  [data-plane-placement.md](data-plane-placement.md).
- The remote ops are unit-tested through the executor with a fake SSH seam;
  a real two-box run (grant → `data_plane_sql` → rows) has not been exercised
  in CI.
