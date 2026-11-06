import pg from "pg";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { it, expect } from "vitest";
import { database, migrate } from "../src/db.js";
import { Engine } from "../src/engine.js";
import {
  documentWorkflow,
  sampleDocument,
  sampleCase,
} from "../src/workflows.js";
it("two worker processes fetch HTML, checkpoint the full pipeline, evaluate and store one report", async () => {
  const admin = database(),
    schema = "test_" + randomUUID().replaceAll("-", "");
  const pool = new pg.Pool({
    ...admin.options,
    options: `-c search_path=${schema}`,
  });
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<html><script>irrelevant injected text</script><body><p>${sampleDocument}</p></body></html>`,
    );
  });
  const children: ChildProcess[] = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No server address");
    const url = `http://127.0.0.1:${address.port}/document`;
    const id = await new Engine(pool, [documentWorkflow]).enqueue(
      "document-report",
      { url, evalCases: [{ ...sampleCase, expected_source: url }] },
    );
    for (const name of ["process-A", "process-B"])
      children.push(
        spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
          env: {
            ...process.env,
            PGOPTIONS: `-c search_path=${schema}`,
            WORKER_ID: name,
          },
          stdio: "ignore",
        }),
      );
    const deadline = Date.now() + 12000;
    let done = false;
    while (Date.now() < deadline) {
      const r = await pool.query("SELECT status FROM runs WHERE id=$1", [id]);
      if (r.rows[0].status === "done") {
        done = true;
        break;
      }
      await sleep(40);
    }
    expect(done).toBe(true);
    const steps = (
      await pool.query(
        "SELECT * FROM steps WHERE run_id=$1 ORDER BY position",
        [id],
      )
    ).rows;
    expect(steps.map((s) => s.attempts)).toEqual([1, 1, 1, 1, 1]);
    expect(steps[1].output[0].text).not.toContain("irrelevant");
    expect(steps[3].output).toMatchObject({
      allPassed: true,
      total: 1,
      passed: 1,
    });
    expect(
      (await pool.query("SELECT * FROM reports WHERE run_id=$1", [id]))
        .rowCount,
    ).toBe(1);
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
    server.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}, 20000);
