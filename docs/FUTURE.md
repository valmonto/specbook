# FUTURE

Where specbook is headed, in order, with the reasoning attached. This is the
direction document — `GAPS.md` lists what's honestly missing today; this file
says what we intend to do about the parts that matter. Filed tasks are linked
by title; everything else here is direction, not commitment.

The through-line: specbook's edge is that its loop ends in **running
software**, not a dashboard. Tickets in → agents build → human court → merged
on GitHub → deployed to hardware the org owns. Every item below either
completes that loop, makes operating the fleet cheaper, or widens what counts
as "work" inside it.

## 1. Finish the deploy platform

The servers → environments → provisioning → build & deploy chain shipped
(PRs #34–#37). Three slices remain:

- **Auto-deploy on merge** — SHIPPED: merges to the default branch redeploy
  opted-in provisioned environments, with an in-flight dedupe and a
  two-failures breaker.
- **Reverse proxy, domains, TLS** — replace `http://<ip>:<port>` with
  `staging.<project>.<domain>`: one Caddy (or nginx + certbot) on the app
  server as the single public listener, per-environment vhosts rendered at
  deploy, wildcard DNS documented. The environment's `domain` field finally
  does something.
- **Storage provisioning** — the data plane covers Postgres and Redis;
  attachments need per-environment buckets + scoped keys on a shared
  S3-compatible store (rustfs), filling `STORAGE_*` in `platform_env`.
- **Edge hardening in the rendered nginx** — the nginx `render.ts` emits is
  the single public listener for every environment specbook deploys, so it
  is the one place to fix an entire fleet's edge at once. Today it serves
  the SPA with no security headers, no HTTP→HTTPS redirect, and a version
  banner. The template should render: a port-80 `return 301`, HSTS on the
  443 block, `X-Frame-Options`/`X-Content-Type-Options`/`Referrer-Policy`/a
  `Content-Security-Policy` on the static document (the API already sends
  these via helmet — the gap is the SPA's first paint, which loads before
  any API response), and `server_tokens off`. An external assessment
  (2026-08-10) surfaced this against a sibling product; specbook's own
  edge shares the shape. App-layer defenses are already in place — throttler
  on auth, allowlisted CORS, helmet on the API — so this is purely the
  transport edge.

Deliberately deferred within the platform: registry-based image transport
(the `docker save | ssh | load` seam is one function; a registry replaces it
when a second app server or slow links appear), multi-server data plane
(data role on a separate box), and production deploys (production stays
outside specbook — a human decision, not a gap).

## 2. Legibility — the operator always knows whose move it is

The first real operator session of the deploy platform (2026-08-04, VXI's
birth) proved the mechanics and indicted the experience. Merge-to-live
worked in three minutes; the human operating it spent an hour lost. Every
pain point was one defect wearing five costumes: **the UI shows state, but
never says what the machine is doing or whose move it is.** Recorded here
so it outranks new features:

- A deployment read "Building…" for 25 minutes with no phase, no elapsed
  time, no logs — diagnosing it required SSHing into the box. (Filed:
  deployment observability.)
- A deploy failure buried its actual cause (missing seed env vars) under
  image-pull noise in the error excerpt. (Same draft; env-var completeness
  filed separately.)
- The deploy-path field accepted a value that could never work and said
  nothing until the deploy died on it. (Filed.)
- The Domain field silently does nothing until the domains slice lands —
  it needs a "not active yet" label instead of quiet acceptance.
- Nothing ever says "waiting for a human": a demo PR sat unmerged for an
  hour while the operator believed the system was stuck; a task whose PR
  was deliberately closed showed a Merge button that could only error; the
  dispatch gate happily dispatched a task no agent could perform. State
  without the pending ACTOR is half a status.

The rule going forward, cheap to apply to every surface: **each row that
represents ongoing work must answer "what is happening right now" and
"who acts next — machine or human — and how."** New platform features do
not ship without it.

## 3. Fleet operations

Running many agents surfaced four needs, filed as drafts:

- **Task cost tracking with project budget caps** — agents report spend
  through the MCP surface they already use; a monthly project budget pauses
  dispatch through the same repository-level gate as merge debt. Today the
  fleet runs cost-blind; this is the highest-value small slice in the file.
- **Agent presence** — registered runners with heartbeats, a live strip on
  the dashboard, and automatic release of claims whose runner went silent
  (never touching `blocked` — silence there is expected).
- **Mid-task operator notes** — a steering channel to a working agent
  ("also rename that button while you're in there"), hard-enforced: the
  review gate refuses `needs_review` while unacked notes exist.
- **CI failure classification** — retryable / setup / external, from webhook
  data only. Flakes re-run once automatically; the auto-mode breaker stops
  pausing whole projects over a single timeout; humans get a named pointer
  instead of "red".

## 4. Widen what counts as work

Specbook's loop is currently hard-wired to code: the review gate demands a
branch and PR, and `done` means merged. But half the valuable agent work in
any real project is not code — architecture research, option comparisons,
copy, specs. That work currently happens outside the tracker and evaporates.

The first cut of this shipped as **Research** — but as its own document type,
not a task _kind_. Bending research onto the task state machine (swapping the
review gate's evidence requirement) was the original plan; the doc-first model
won because a research deliverable is a _living, versioned document_, not a
one-shot PR, and the conversation that produces it is async and multi-turn.
See `docs/product-design.md` → Research for what exists.

- **Research documents** — a first-class `research` entity (title, nullable
  `project_id`, `body_markdown`, `version`, `researching → needs_review →
accepted` status) with a message conversation. Appending a message moves the
  document back to `researching`; the ambient dispatch runner pulls it from
  `list_research` and its reply publishes a new draft (new body, bumped version,
  → `needs_review`). Data model, REST/MCP API, keyset listing, the agent tools
  (`get_research`, `list_research`, `append_research_message`), the runner turn
  and the web UI exist today. **Still to build:** the mobile UI.
- **Research → tickets ("cut tickets")** — an accepted document's natural
  output is a set of _draft_ build tasks cut from it, each carrying
  `source_research_id` lineage. This exists (REST `POST /research/:id/cut-tickets`,
  gated by `task:create`). It is the ideation pipeline done specbook's way: the
  machine proposes at two gated points, the human decides at both. What we will
  NOT build is autonomous backlog generation that files work without a human
  gate — the Ready boundary is the product's discipline, not a friction to
  remove.

## 5. Going public

The product's best argument is a demo that is structurally hard to fake:
_write a ticket on camera, walk away, come back to the feature running on
staging._ The distribution work, in order:

1. Close the loop (auto-deploy) so the demo is real end to end.
2. Record it; put it at the top of a README that tells the story in 90
   seconds.
3. `install.sh` + docker-compose onboarding: fresh box to first ticket in
   ten minutes, including the "bring a $5 VPS" step.
4. Own the opinionation: specbook deploys one blessed stack (the valmatic
   convention) from ticket to staging. "Deploys anything" is a swamp;
   "the full loop for one stack, done completely" is a position.
5. Write-ups that can travel on their own: how specbook built itself
   (the git history is the receipt), and the security model (scoped MCP
   keys, one-hour minted tokens, write-only secrets, agents that
   structurally cannot merge their own work or read a credential).

Going public also buys obligations — strangers' issues, security scrutiny of
a system that holds SSH keys, maintenance that can't all be dispatched to
agents. That cost is accepted, not accidental.

## Deliberately not planned

Recorded so future sessions don't relitigate:

- **Autonomous ideation / market-research autopilot** — see §3; proposals
  must land as drafts behind the human gate, or not at all.
- **A second memory/knowledge store** — the project context document is the
  knowledge system, and it is better than a memory database because it is
  reviewed. Agent runtimes bring their own memory.
- **Sub-task orchestration graphs** — task dependencies and claim caps
  exist; parallelism inside one task is the runner's concern, not the
  tracker's.
- **Preview environments per PR** — the environment model could express it
  ("create env on PR open, destroy on close"), but staging-tracks-main plus
  browser-verified evidence on the PR answers the review question at a
  fraction of the complexity. Revisit only if review practice proves
  otherwise.
- **Registry, multi-server data plane, production deploys** — see §1.
