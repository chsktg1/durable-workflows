# Durable workflows

A small TypeScript workflow engine backed by PostgreSQL. Ordered named steps,
durable output checkpoints, competing workers, bounded retries, dead letters,
and a React execution console. The product is the crash demo.

## Run it

Requires Node.js 22.12+ (CI uses 24), npm, and PostgreSQL 17 or Docker Compose.

```sh
npm ci
docker compose up -d --wait
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/durable_workflows
npm run migrate
npm run build
npm start                        # dashboard + API: http://127.0.0.1:3000
```

In another terminal, export the same `DATABASE_URL`, then:

```sh
npm run worker                   # start a second terminal/worker to compete
npm run enqueue -- '{}'          # or use New sample run in the dashboard
```

For UI development, `npm run dev` serves Vite at http://127.0.0.1:5173 and the
API at port 3000. Run a worker separately. `.env.example` documents settings;
export variables explicitly (the app does not implicitly load `.env`).

## Kill a worker and prove recovery

Use an otherwise idle database with no unrelated queued runs or workers:

```sh
npm run demo:crash
```

The script starts real Node worker processes, waits for the report side effect
to commit while its step is still running, sends **SIGKILL (`kill -9`)**, waits
for process exit, and starts a replacement worker. It asserts checkpoint attempt
counts, final run state, interrupted-attempt history, and a single stored report.
It leaves the finished run available to inspect in the dashboard.

Actual output recorded locally against PostgreSQL 17 on November 6, 2026
(full log: [docs/crash-demo-output.txt](docs/crash-demo-output.txt)):

```text
CRASH DEMO run=4813d8f2-d166-4e8f-9e84-49ca25ab195a
worker-A START fetch attempt=1 run=4813d8f2-d166-4e8f-9e84-49ca25ab195a
worker-A DONE fetch attempt=1
worker-A START extract attempt=1 run=4813d8f2-d166-4e8f-9e84-49ca25ab195a
worker-A DONE extract attempt=1
worker-A START summarize attempt=1 run=4813d8f2-d166-4e8f-9e84-49ca25ab195a
worker-A DONE summarize attempt=1
worker-A START evaluate attempt=1 run=4813d8f2-d166-4e8f-9e84-49ca25ab195a
worker-A DONE evaluate attempt=1
worker-A START store-report attempt=1 run=4813d8f2-d166-4e8f-9e84-49ca25ab195a
EFFECT_COMMITTED 4813d8f2-d166-4e8f-9e84-49ca25ab195a:store-report; pausing before checkpoint
kill -9 worker-A (report committed, step not checkpointed)
Starting replacement worker-B
worker-B START store-report attempt=2 run=4813d8f2-d166-4e8f-9e84-49ca25ab195a
worker-B DONE store-report attempt=2
fetch: done, attempts=1
extract: done, attempts=1
summarize: done, attempts=1
evaluate: done, attempts=1
store-report: done, attempts=2
Reports stored: 1
PASS: completed steps were not rerun; interrupted step retried; side effect stored exactly once.
```

## Define workflows in TypeScript

```ts
import type { Workflow } from "./src/engine.js";

const invoice: Workflow = {
  name: "invoice",
  version: 1,
  steps: [
    {
      name: "prepare",
      async run({ input }) {
        return input;
      },
    },
    {
      name: "charge",
      maxAttempts: 5,
      baseDelayMs: 1000,
      async run({ outputs, idempotencyKey, signal }) {
        // Send idempotencyKey to a provider that enforces it durably.
        // Use signal for cancellation; return a JSON-serializable receipt.
        return { prepared: outputs.prepare, key: idempotencyKey };
      },
    },
  ],
};
```

Register definitions in `new Engine(pool, [invoice])` on enqueue and worker sides.
Step names must be unique. Outputs and inputs are JSON. Keep a definition
immutable once used: new behavior belongs in a new version, and workers must
retain old versions until their runs drain. Step name/count drift is rejected;
function-body changes cannot be detected automatically.

## Architecture and recovery

```text
CLI / React console → Express API → runs + ordered steps (Postgres)
                                      ↑          ↓
                          worker A / worker B → step function
                                      ↓
                     atomic output checkpoint + attempt history
                                      ↓
                          next step / retry / dead letter
```

1. Enqueue atomically persists a run and its ordered step definitions/retry policy.
2. A worker selects eligible runs with `SELECT … FOR UPDATE SKIP LOCKED`. It
   obtains a session advisory lock for one run, records the running step and
   attempt, and commits the short claim transaction. Other workers can claim
   different runs. One step at a time runs per workflow.
3. The session lock stays held during execution. Another worker cannot reclaim
   the same run just because execution is slow. The dashboard can see running
   status because the row transaction is already committed. A dedicated database
   connection is held per executing worker; use direct Postgres or session
   pooling, **not PgBouncer transaction pooling**.
4. Completion atomically stores the output, ends attempt history, and makes the
   next step eligible (or marks the run done). Completed steps are never selected.
5. SIGKILL closes the connection; Postgres releases the session lock. A new
   worker marks the abandoned attempt interrupted and retries the unfinished
   step. It reads earlier outputs from checkpoints. A crash consumes an attempt;
   recovery is immediately eligible. If the budget is spent, it dead-letters.
6. Thrown step errors schedule `min(base × 2^(attempt−1), 1 hour)` with database
   time. `maxAttempts` includes the first execution. Pending retries display a
   failed step, its error and next eligible time. Exhausted runs enter
   `dead_letter`. Requeue resets only the failed step's attempt budget and times;
   previous attempt history, completed outputs, and idempotency keys remain.

Postgres locking behavior is documented in the
[PostgreSQL locking reference](https://www.postgresql.org/docs/17/explicit-locking.html).
The queue claim scans up to 100 eligible rows per poll. This is a small engine,
not a tuned high-throughput scheduler; many occupied oldest runs can temporarily
starve newer work. No long database transaction spans an external step.

## Idempotency: what is actually guaranteed

Delivery is **at least once**. A process may die after an effect succeeds and
before its checkpoint commits. The step body then runs again. Stable keys are
`${runId}:${stepName}`, including across retries and manual requeue.

For database effects, `ctx.effect(async tx => …)` runs the effect and a keyed
result record in one Postgres transaction. A transaction advisory lock serializes
calls for the key. A retry returns the saved result. The example inserts the
report using the supplied `tx`; both the report key and effect ledger key are
unique. Use one logical effect per step/helper key. Do not make network calls
inside this helper and assume they become transactional.

For external effects, pass `ctx.idempotencyKey` to a provider that enforces durable
idempotency, or use an outbox plus an idempotent consumer. A local ledger cannot
atomically commit an arbitrary HTTP request. No universal exactly-once execution
is claimed. If a database session is lost while a process stays alive (network
partition), the engine aborts its signal and refuses its checkpoint; custom code
must honor cancellation, and remote systems still require idempotency/fencing.
Recovery waits for Postgres to detect dead connections; it is not a timed lease.

## Document → evaluated report

The real example is `fetch → extract → summarize → evaluate → store-report`.
It fetches HTTP(S) text/HTML (2 MB cap, 15-second fetch timeout), extracts text,
creates a deterministic extractive summary with chunk citations, runs the
actual RAG Eval Harness lexical checks, and stores the report in Postgres.
The default embedded document makes the crash demo reproducible offline; the
integration suite also fetches a real local HTTP document with two worker
processes. No paid model or API key is required. PDFs and LLM summarization are
not implemented.

```sh
npm run enqueue -- '{"url":"https://example.com/document.txt","evalCases":[{"id":"policy","question":"What is the policy?","answerable":true,"expected_source":"https://example.com/document.txt","expected_evidence":"expected passage","expected_keywords":["policy"]}]}'
```

Checks: retrieval hit, used evidence, source present, expected keywords, and
80% lexical grounding, plus the original unanswerable/abstention rule. See
[port provenance and limitations](docs/rag-eval-provenance.md). Custom documents
without authored eval cases are explicitly unevaluated (`total: 0,
allPassed: false`). Quality flags are stored in the report, not treated as an
infrastructure exception.

## Inspect failures and requeue

The console has a run list, ordered step timeline, timestamps, retry budgets,
output checkpoints, attempt history, stored report, and a Dead letters view
with Requeue. **Test failure** creates a deterministic evaluation exception.
It will fail again after requeue until the underlying behavior is fixed;
requeue intentionally does not silently alter inputs or bypass a failed step.

```sh
npm run requeue -- RUN_UUID
curl http://127.0.0.1:3000/api/runs
curl 'http://127.0.0.1:3000/api/runs?status=dead_letter'
curl http://127.0.0.1:3000/api/runs/RUN_UUID
curl -X POST http://127.0.0.1:3000/api/runs/RUN_UUID/requeue
```

The API binds to loopback and has no authentication or multi-tenancy. It is a
local development console; put authentication and authorization in front of
any shared deployment. URL fetching is available through trusted CLI/code
inputs, not the dashboard's sample-only enqueue endpoint.

## Verify

```sh
npm run typecheck
npm test
npm run build
npm run demo:crash
```

Tests use real Postgres, create random isolated schemas, and drop only those
schemas afterward. The database role needs schema creation privileges. Tests
cover checkpoint/resume, output propagation, concurrent claims, retry eligibility
and backoff, dead letter/requeue, committed-effect deduplication, transaction
rollback, definition drift, RAG flags, and an HTTP pipeline run using two separate
worker processes. GitHub Actions runs the checks and crash demo against Postgres.

## What Temporal does that this doesn't

This engine checkpoints explicit activities; it does not replay arbitrary
workflow code or sandbox nondeterminism. Temporal provides deterministic history
replay, durable timers, signals/queries, child workflows, cancellation protocols,
activity heartbeats/timeouts, task routing, scalable history services, workflow
code versioning tools, operational visibility, and a mature SDK/runtime.

Here there are no durable timers beyond retry eligibility, DAGs/parallel branches,
signals, schedules, compensation, authentication, retention tooling, general
step timeouts, or automatic code migration. A hung step holds its session lock
until stopped; network-aware steps should use the supplied signal and their
own deadline. Retry delays have no jitter. Each worker runs one step at a time,
polls every 200 ms, and holds one session connection; database effects briefly
need an additional connection. Checkpoint payloads live directly in Postgres,
so large documents should use object storage references in a production design.
