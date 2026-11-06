import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { database, migrate } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { documentWorkflow } from "../src/workflows.js";
const pool = database(),
  engine = new Engine(pool, [documentWorkflow]);
const children: ChildProcess[] = [];
async function waitFor(check: () => Promise<boolean>, description: string) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
function worker(name: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
    env: { ...process.env, WORKER_ID: name },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (data) => process.stdout.write(data));
  child.stderr!.on("data", (data) => process.stderr.write(data));
  children.push(child);
  return child;
}
try {
  await migrate(pool);
  const id = await engine.enqueue("document-report", { crashDemo: true });
  console.log(`CRASH DEMO run=${id}`);
  const first = worker("worker-A");
  await waitFor(async () => {
    const r = await pool.query("SELECT 1 FROM reports WHERE run_id=$1", [id]);
    const s = await pool.query(
      "SELECT 1 FROM steps WHERE run_id=$1 AND name='store-report' AND status='running'",
      [id],
    );
    return !!r.rowCount && !!s.rowCount;
  }, "committed report before checkpoint");
  console.log("kill -9 worker-A (report committed, step not checkpointed)");
  const exited = once(first, "exit");
  first.kill("SIGKILL");
  await exited;
  console.log("Starting replacement worker-B");
  worker("worker-B");
  await waitFor(
    async () =>
      (await pool.query("SELECT status FROM runs WHERE id=$1", [id])).rows[0]
        .status === "done",
    "run completion",
  );
  const rows = (
    await pool.query(
      "SELECT name,status,attempts FROM steps WHERE run_id=$1 ORDER BY position",
      [id],
    )
  ).rows;
  const reports = (
    await pool.query("SELECT count(*)::int AS n FROM reports WHERE run_id=$1", [
      id,
    ])
  ).rows[0].n;
  for (const [i, s] of rows.entries()) {
    assert.equal(s.status, "done");
    assert.equal(s.attempts, i === 4 ? 2 : 1);
    console.log(`${s.name}: ${s.status}, attempts=${s.attempts}`);
  }
  assert.equal(reports, 1);
  console.log(`Reports stored: ${reports}`);
  const history = (
    await pool.query(
      "SELECT status FROM attempts WHERE run_id=$1 AND position=4 ORDER BY id",
      [id],
    )
  ).rows;
  assert.deepEqual(
    history.map((a) => a.status),
    ["interrupted", "done"],
  );
  console.log(
    "PASS: completed steps were not rerun; interrupted step retried; side effect stored exactly once.",
  );
} finally {
  await Promise.all(
    children.map(async (c) => {
      if (c.exitCode === null && c.signalCode === null) {
        const done = once(c, "exit");
        c.kill("SIGTERM");
        await done;
      }
    }),
  );
  await pool.end();
}
