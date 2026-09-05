# Data-plane placement

Where an environment's **database**, **cache** and **storage** run, and how the
app reaches them. Additive to the original single-box design: nothing already
deployed changes behaviour.

## The roles

| Role       | Means                                                                                               | Offered when adding a server             |
| ---------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `app`      | runs the environment's compose stack (api, worker, web, proxy)                                      | yes                                      |
| `build`    | builds images                                                                                       | yes                                      |
| `runner`   | runs agents                                                                                         | yes                                      |
| `database` | hosts the shared Postgres other boxes connect to                                                    | yes                                      |
| `cache`    | hosts per-environment Redis other boxes connect to                                                  | yes                                      |
| `storage`  | reserved for buckets + access keys — **placement accepted by the API, provisioning is a follow-up** | yes                                      |
| `data`     | **legacy, combined**: Postgres + Redis co-located on the app server, container-DNS wiring           | **no** — stays valid on existing servers |

`data` is kept exactly as it was. Every existing server row and every
environment with NULL placement keeps working, byte-identical wiring included
(`packages/server/__tests__/modules/deploy/placement.test.ts` pins that). It
is no longer in the Add-server picker, so the fleet converges on the granular
roles without a migration; the Edit dialog shows it as "Data (legacy)".

## The placement fields

`project_environment` gained `database_server_id`, `cache_server_id`,
`storage_server_id` (nullable, `ON DELETE RESTRICT` like `server_id`) and
`data_transport`. **NULL means today's behaviour**: that role lives on the app
server under its `data` role. Set means: provision that role on that server,
which must hold the matching granular role — the legacy `data` role never
satisfies a _remote_ placement.

Validation happens at create/update, never at provision time:

- the named server must be the org's own and hold the role → otherwise
  `serverNotDatabase` / `serverNotCache` / `serverNotStorage`;
- any role moved off the app server needs `data_transport` → `transportRequired`;
- `tls` is in the schema but nothing installs certificates yet → `transportTlsUnsupported`;
- storage placement → `storageProvisionUnsupported` (follow-up).

## Network reality — why this is not just a schema change

The co-located path publishes **nothing** on a host port: Postgres and Redis are
reached over the `specbook-data` docker network by container name. Once a role
moves to another box it must be reachable over a network. Two cases:

1. **Trusted private network** (`data_transport = private-network`): two libvirt
   guests on one host bridge, or a cloud private network. Postgres/Redis are
   published on the placement server's **registered `host` address only** —
   the address the app server reaches it on — never `0.0.0.0` (the remote ops
   refuse it). Firewall those ports to the app host yourself; the
   acknowledgement in the form is you saying that network is trusted.
2. **Anything else** requires TLS (`sslmode=verify-full`). The field exists so
   the intent is recorded; provisioning it (server certificates, client CA) is
   the follow-up. Plain unencrypted over an unstated network is **refused**,
   not warned about.

## What the provisioner does per role

| Placement      | Database server                                                  | Cache server                                              | App server                                                    |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| NULL (legacy)  | —                                                                | —                                                         | `data-plane-ensure` + `data-plane-provision-unit` (unchanged) |
| database moved | `data-plane-ensure-published <host>` + `database-provision-unit` | —                                                         | `app-network-ensure` + a password-protected local Redis       |
| cache moved    | —                                                                | `cache-provision-unit <unit> <host> <port>` (requirepass) | legacy ensure + provision-unit (Postgres half used)           |
| both moved     | as above                                                         | as above                                                  | `app-network-ensure`                                          |

Rendered wiring (`platform_env`): a moved database becomes
`postgresql://<unit>:<pw>@<db-host>:5432/<unit>` (`?sslmode=verify-full` under
`tls`); a moved cache becomes `REDIS_HOST=<cache-host>`, `REDIS_PORT=<derived
30000–37999>`, `REDIS_PASSWORD=<per-unit>`. The untouched role keeps its exact
legacy value. The deploy passes `REDIS_PORT`/`REDIS_PASSWORD` through to
`IAM_REDIS_*` when present and omits them otherwise.

One Postgres instance per server: N environments across N projects that share
a `database_server_id` share one Postgres, each with its own role + database
(the unit name), exactly as the co-located path already did. **Settings →
Servers → "Environments on this server"** shows who shares an instance and as
what.

Teardown follows placement: the app server runs the original
`data-plane-deprovision-unit`; a moved database or cache gets its own
`database-deprovision-unit` / `cache-deprovision-unit` on its server. All
best-effort — a dead box never blocks deletion.

## Guidance

- Keep the **cache next to the app** unless you have a reason: Redis carries
  sessions and BullMQ queues, many small round trips, latency-sensitive.
- Move the **database** when it wants its own disk, and put it on a private
  network you actually control.
- Leave **storage** on the app server until its provisioning lands.
