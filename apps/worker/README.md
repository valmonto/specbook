# `apps/worker`

Background job processing. The API enqueues work into Redis and returns; this
service picks it up and runs it, so a slow task never holds a request open.

A NestJS app like `apps/api`, but with no controllers — its inputs are queue
jobs and events, not HTTP.

## Layout

```
src/
├── queues/
│   ├── example/
│   │   ├── example.processor.ts       runs the job
│   │   ├── example.listener.ts        reacts to events the job emits
│   │   └── notification.repository.ts writes to the database
│   └── queues.module.ts               register processors here
├── config/env.schema.ts               Zod-validated env
└── main.ts
```

## Two ways work arrives

**Queue jobs** — durable, cross-service. The API's producer adds a job to Redis;
a `@Processor` here consumes it. Survives a restart, retries on failure.

**Events** — in-process, same service. A processor emits `AppEvents.*`, an
`@OnEvent` listener reacts. Does _not_ survive a restart, and never crosses to
another service. It is for fan-out after work succeeds — writing a notification
row, say — not for the work itself.

The example flow shows both: `ExampleProcessor` runs the job and emits
started/completed/failed events, and `ExampleListener` turns those into
notification rows.

## Adding a queue

The queue is **defined in `@pkg/server`**, not here, because both services need
it — the API to enqueue, the worker to consume.

1. In `@pkg/server/modules/queues/thing/`: constants (name, worker options),
   the payload and result types, and the producer the API will inject.
2. Here, `src/queues/thing/thing.processor.ts`:

```ts
@Processor(THING_QUEUE.name, THING_QUEUE.workerOptions)
export class ThingProcessor extends WorkerHost {
  async process(job: Job<ThingJobPayload>): Promise<ThingJobResult> { … }
}
```

3. Register it in `queues.module.ts` — a processor that is not listed there
   never runs, and nothing complains.
4. Enqueue from the API by injecting the producer.

Concurrency, retries and backoff live in the queue's `workerOptions`, so both
services read the same numbers.

## Job state belongs to the feature

BullMQ is **transport, not a record**. Completed jobs are dropped from Redis
(`removeOnComplete: true`); failures are kept for inspection but only in Redis,
so a flush loses them.

A feature that needs job state to outlive the job — progress to show a user,
a result to fetch later, an audit trail — gives it a table:

```
import_run          id · status · started_at · finished_at · rows · error
report_generation   id · requested_by · status · output_url
```

The processor writes to that table; the queue only carries the trigger. There
is deliberately no generic `job_run` table, because retention, PII in payloads
and who reads it are all decisions the owning feature should make.

If nothing outside the job needs the outcome, no table is needed — the log line
is enough.

## Notes

- **Idempotency is your job.** BullMQ retries, so a processor that charges a
  card or sends an email must tolerate running twice on the same job.
- It listens on `WORKER_PORT` (default 3001) for `/health`, which probes both
  Postgres and Redis. Redis matters most here: it is the only way jobs arrive,
  so a worker that cannot reach it processes nothing.
  The same route serves the worker's build identity (`sha`, `builtAt`) from the
  image's `GIT_SHA`/`BUILT_AT` build args, so a stale worker image is as
  visible as a stale api.
- Env is validated at boot by `validateEnv`; a bad `DATABASE_URL` fails the
  process rather than surfacing on first query.
- Scale by running more replicas. `concurrency` is per replica.
- **A deployed environment seeds its owner until it first comes up healthy.**
  The deploy renders `SEED_ON_STARTUP=true` into the app's `.env` while the
  environment has no `healthy` deployment on record; the api's production
  seeder then creates the owner from `SEED_INITIAL_EMAIL` /
  `SEED_INITIAL_PASSWORD`. Repeating it is safe — the seeder is idempotent and
  never overwrites an existing password. This used to key off "did this run
  mint the runtime secrets", which is a different question: secrets are minted
  during `render`, before the stack starts, so one deploy that rendered and
  then died at migrate burned the only seeded run. The environment then went
  healthy forever with no owner account and a `SEED_INITIAL_PASSWORD` that had
  never been applied — visible only as `invalid email or password` at login.
  **To seed an environment that is already healthy but was never seeded**, set
  `SEED_ON_STARTUP=true` in its user env, redeploy, then remove it.

## Commands

```bash
pnpm dev --filter @pkg/worker    # watch mode
pnpm --filter @pkg/worker test                            # processors with faked deps
DATABASE_URL=postgresql://… pnpm --filter @pkg/worker test # + repository integration
```

Redis and Postgres must be running — `docker compose up -d` at the root.

## Testing

Processor tests fake the queue job and assert on results and emitted events;
the repository suite runs against a real database via `describeIntegration`
(needs `DATABASE_URL`, skips silently without). See
[`@pkg/testing`](../../packages/testing/README.md) for which kind of test to
write.
