import { setTimeout as sleep } from "node:timers/promises";
import { database } from "./db.js";
import { Engine } from "./engine.js";
import { documentWorkflow } from "./workflows.js";
const pool = database(),
  engine = new Engine(pool, [documentWorkflow]);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
try {
  while (!stopping) {
    try {
      if (!(await engine.tick(process.env.WORKER_ID))) await sleep(200);
    } catch (e) {
      console.error("worker error", e instanceof Error ? e.message : e);
      await sleep(1000);
    }
  }
} finally {
  await pool.end();
}
