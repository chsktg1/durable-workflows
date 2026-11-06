import { randomUUID } from "node:crypto";
import type pg from "pg";
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Context {
  runId: string;
  input: Json;
  outputs: Record<string, Json>;
  idempotencyKey: string;
  attempt: number;
  signal: AbortSignal;
  /** Only database effects inside this callback are atomic with the deduplication record. */
  effect<T extends Json>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
}
export interface Step {
  name: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  run(ctx: Context): Promise<Json>;
}
export interface Workflow {
  name: string;
  version: number;
  steps: Step[];
}
export const backoff = (base: number, attempt: number) =>
  Math.min(3_600_000, base * 2 ** Math.min(30, attempt - 1));
export class Engine {
  registry = new Map<string, Workflow>();
  constructor(
    public pool: pg.Pool,
    workflows: Workflow[],
  ) {
    for (const w of workflows) {
      if (
        !w.steps.length ||
        new Set(w.steps.map((s) => s.name)).size !== w.steps.length
      )
        throw new Error("Steps must be nonempty and uniquely named");
      for (const s of w.steps)
        if (
          !Number.isInteger(s.maxAttempts ?? 3) ||
          (s.maxAttempts ?? 3) < 1 ||
          !Number.isInteger(s.baseDelayMs ?? 1000) ||
          (s.baseDelayMs ?? 1000) < 0
        )
          throw new Error("Invalid retry policy");
      const key = `${w.name}@${w.version}`;
      if (this.registry.has(key)) throw new Error(`Duplicate workflow ${key}`);
      this.registry.set(key, w);
    }
  }
  async enqueue(name: string, input: Json = {}, version = 1) {
    const w = this.registry.get(`${name}@${version}`);
    if (!w) throw new Error("Unknown workflow/version");
    const id = randomUUID(),
      c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO runs(id,workflow,version,input) VALUES($1,$2,$3,$4)",
        [id, name, version, JSON.stringify(input)],
      );
      for (const [i, s] of w.steps.entries())
        await c.query(
          "INSERT INTO steps(run_id,position,name,max_attempts,base_delay_ms) VALUES($1,$2,$3,$4,$5)",
          [id, i, s.name, s.maxAttempts ?? 3, s.baseDelayMs ?? 1000],
        );
      await c.query("COMMIT");
      return id;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async effect<T extends Json>(
    key: string,
    fn: (tx: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
        key,
      ]);
      const existing = await c.query(
        "SELECT output FROM effects WHERE key=$1",
        [key],
      );
      const result = existing.rowCount
        ? (existing.rows[0].output as T)
        : await fn(c);
      if (!existing.rowCount)
        await c.query("INSERT INTO effects(key,output) VALUES($1,$2)", [
          key,
          JSON.stringify(result),
        ]);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async requeue(id: string) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        "SELECT id FROM runs WHERE id=$1 AND status='dead_letter' FOR UPDATE",
        [id],
      );
      if (!r.rowCount) throw new Error("Run is not dead-lettered");
      // The history retains lifetime attempts. Manual requeue gives the failed step a fresh retry budget.
      await c.query(
        "UPDATE steps SET status='pending',attempts=0,available_at=now(),error=NULL,started_at=NULL,finished_at=NULL WHERE run_id=$1 AND status='failed'",
        [id],
      );
      await c.query(
        "UPDATE runs SET status='pending',updated_at=now() WHERE id=$1",
        [id],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async tick(worker = `worker-${process.pid}`): Promise<boolean> {
    const c = await this.pool.connect();
    const abort = new AbortController();
    const onError = (e: Error) => abort.abort(e);
    c.on("error", onError);
    let locked: string | undefined;
    try {
      await c.query("BEGIN");
      // Row locks make claims nonblocking; session locks survive the short claim transaction.
      const candidates =
        await c.query(`SELECT r.* FROM runs r WHERE r.status IN ('pending','running')
        AND EXISTS (SELECT 1 FROM steps s WHERE s.run_id=r.id AND s.status!='done' AND s.available_at<=now()
          AND NOT EXISTS(SELECT 1 FROM steps p WHERE p.run_id=r.id AND p.position<s.position AND p.status!='done'))
        ORDER BY r.created_at LIMIT 100 FOR UPDATE OF r SKIP LOCKED`);
      let run: any;
      for (const r of candidates.rows) {
        const lock = await c.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
          [r.id],
        );
        if (lock.rows[0].ok) {
          locked = r.id;
          run = r;
          break;
        }
      }
      if (!run) {
        await c.query("COMMIT");
        return false;
      }
      const all = (
        await c.query("SELECT * FROM steps WHERE run_id=$1 ORDER BY position", [
          run.id,
        ])
      ).rows;
      const step = all.find((s) => s.status !== "done");
      const w = this.registry.get(`${run.workflow}@${run.version}`);
      if (
        !w ||
        all.length !== w.steps.length ||
        all.some((s, i) => s.name !== w.steps[i].name)
      )
        throw new Error(
          `Workflow definition unavailable or changed: ${run.workflow}@${run.version}`,
        );
      if (step.status === "running") {
        await c.query(
          "UPDATE attempts SET status='interrupted',finished_at=now(),error='Worker connection lost before checkpoint' WHERE run_id=$1 AND position=$2 AND status='running'",
          [run.id, step.position],
        );
      }
      if (step.attempts >= step.max_attempts) {
        await c.query(
          "UPDATE steps SET status='failed',finished_at=now(),error='Retry budget exhausted after interrupted execution' WHERE run_id=$1 AND position=$2",
          [run.id, step.position],
        );
        await c.query(
          "UPDATE runs SET status='dead_letter',updated_at=now() WHERE id=$1",
          [run.id],
        );
        await c.query("COMMIT");
        return true;
      }
      const attempt = step.attempts + 1;
      await c.query(
        "UPDATE steps SET status='running',attempts=$3,started_at=now(),finished_at=NULL,error=NULL WHERE run_id=$1 AND position=$2",
        [run.id, step.position, attempt],
      );
      const history = await c.query(
        "INSERT INTO attempts(run_id,position,number,worker,status) VALUES($1,$2,$3,$4,'running') RETURNING id",
        [run.id, step.position, attempt, worker],
      );
      await c.query(
        "UPDATE runs SET status='running',updated_at=now() WHERE id=$1",
        [run.id],
      );
      await c.query("COMMIT");
      console.log(
        `${worker} START ${step.name} attempt=${attempt} run=${run.id}`,
      );
      let output: Json;
      try {
        const key = `${run.id}:${step.name}`;
        output = await w.steps[step.position].run({
          runId: run.id,
          input: run.input,
          outputs: Object.fromEntries(
            all
              .filter((s) => s.status === "done")
              .map((s) => [s.name, s.output]),
          ),
          idempotencyKey: key,
          attempt,
          signal: abort.signal,
          effect: (fn) => this.effect(key, fn),
        });
        // Fail before checkpoint if the owning session was lost. External effects still need their own fencing/idempotency.
        abort.signal.throwIfAborted();
        if (output === undefined)
          throw new Error("Step must return JSON (use null for no output)");
        JSON.stringify(output);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const dead = attempt >= step.max_attempts;
        await c.query("BEGIN");
        await c.query(
          "UPDATE steps SET status='failed',error=$3,finished_at=now(),available_at=now()+($4 * interval '1 millisecond') WHERE run_id=$1 AND position=$2",
          [
            run.id,
            step.position,
            message,
            backoff(step.base_delay_ms, attempt),
          ],
        );
        await c.query(
          "UPDATE attempts SET status='failed',finished_at=now(),error=$2 WHERE id=$1",
          [history.rows[0].id, message],
        );
        await c.query(
          "UPDATE runs SET status=$2,updated_at=now() WHERE id=$1",
          [run.id, dead ? "dead_letter" : "pending"],
        );
        await c.query("COMMIT");
        console.log(
          `${worker} ${dead ? "DEAD_LETTER" : "RETRY"} ${step.name}: ${message}`,
        );
        return true;
      }
      await c.query("BEGIN");
      await c.query(
        "UPDATE steps SET status='done',output=$3,finished_at=now() WHERE run_id=$1 AND position=$2",
        [run.id, step.position, JSON.stringify(output)],
      );
      await c.query(
        "UPDATE attempts SET status='done',finished_at=now() WHERE id=$1",
        [history.rows[0].id],
      );
      await c.query("UPDATE runs SET status=$2,updated_at=now() WHERE id=$1", [
        run.id,
        step.position === all.length - 1 ? "done" : "pending",
      ]);
      await c.query("COMMIT");
      console.log(`${worker} DONE ${step.name} attempt=${attempt}`);
      return true;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      let destroy = abort.signal.aborted;
      if (locked)
        try {
          await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            locked,
          ]);
        } catch {
          destroy = true;
        }
      c.off("error", onError);
      c.release(destroy);
    }
  }
}
