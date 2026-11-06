import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { database, migrate } from "../src/db.js";
import { Engine, backoff, type Workflow } from "../src/engine.js";
// Integration tests require a dedicated, disposable database. Never truncate application data.
const admin = database();
const schema = "test_" + randomUUID().replaceAll("-", "");
const pool = new pg.Pool({
  ...admin.options,
  options: `-c search_path=${schema}`,
});
const ids: string[] = [];
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
const workflow = (steps: Workflow["steps"]): Workflow => ({
  name: "test",
  version: 1,
  steps,
});
async function enqueue(e: Engine) {
  const id = await e.enqueue("test");
  ids.push(id);
  return id;
}
async function state(id: string) {
  return (
    await pool.query("SELECT * FROM steps WHERE run_id=$1 ORDER BY position", [
      id,
    ])
  ).rows;
}
// Every test invocation creates and drops its own random schema.
describe("Postgres workflow engine", () => {
  beforeEach(async () => {
    // Remove previous test queue entries so workers cannot consume a different test's run.
    if (ids.length)
      await pool.query(
        "UPDATE runs SET status='dead_letter' WHERE id=ANY($1::uuid[]) AND status!='done'",
        [ids],
      );
  });
  it("resumes a new engine from durable checkpoints with named previous outputs", async () => {
    let calls = 0;
    const w = workflow([
      {
        name: "one",
        async run() {
          calls++;
          return { value: 42 };
        },
      },
      {
        name: "two",
        async run(ctx) {
          return ctx.outputs.one;
        },
      },
    ]);
    const e = new Engine(pool, [w]),
      id = await enqueue(e);
    await e.tick();
    expect((await state(id))[0].output).toEqual({ value: 42 });
    await new Engine(pool, [w]).tick();
    expect(calls).toBe(1);
    expect((await state(id))[1].output).toEqual({ value: 42 });
  });
  it("claims one step once across two simultaneous workers", async () => {
    let executions = 0;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const w = workflow([
      {
        name: "once",
        async run() {
          executions++;
          started();
          await gate;
          return "ok";
        },
      },
    ]);
    const e = new Engine(pool, [w]),
      id = await enqueue(e);
    const a = e.tick("a");
    await entered;
    try {
      expect(await new Engine(pool, [w]).tick("b")).toBe(false);
      expect(executions).toBe(1);
    } finally {
      release();
      await a;
    }
    expect((await state(id))[0].attempts).toBe(1);
  });
  it("enforces exponential eligibility, max attempts, dead letters and requeue", async () => {
    let broken = true;
    const w = workflow([
      {
        name: "flaky",
        baseDelayMs: 1000,
        maxAttempts: 2,
        async run() {
          if (broken) throw new Error("offline");
          return "recovered";
        },
      },
    ]);
    const e = new Engine(pool, [w]),
      id = await enqueue(e);
    const before = Date.now();
    await e.tick();
    const s = (await state(id))[0];
    expect(new Date(s.available_at).getTime()).toBeGreaterThanOrEqual(
      before + 990,
    );
    await pool.query(
      "UPDATE steps SET available_at=now()+interval '1 hour' WHERE run_id=$1",
      [id],
    );
    expect(await e.tick()).toBe(false);
    await pool.query("UPDATE steps SET available_at=now() WHERE run_id=$1", [
      id,
    ]);
    await e.tick();
    expect(
      (await pool.query("SELECT status FROM runs WHERE id=$1", [id])).rows[0]
        .status,
    ).toBe("dead_letter");
    expect(await e.tick()).toBe(false);
    broken = false;
    await e.requeue(id);
    await e.tick();
    expect((await state(id))[0].status).toBe("done");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM attempts WHERE run_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(3);
    expect([1, 2, 3, 4].map((a) => backoff(100, a))).toEqual([
      100, 200, 400, 800,
    ]);
    expect(backoff(1000, 100)).toBe(3600000);
  });
  it("deduplicates committed effects after a step fails before its checkpoint", async () => {
    let effects = 0;
    const w = workflow([
      {
        name: "effect",
        baseDelayMs: 0,
        async run(ctx) {
          const value = await ctx.effect(async () => {
            effects++;
            return { receipt: "saved" };
          });
          if (ctx.attempt === 1) throw new Error("crash window");
          return value;
        },
      },
    ]);
    const e = new Engine(pool, [w]),
      id = await enqueue(e);
    await e.tick();
    await new Engine(pool, [w]).tick();
    expect(effects).toBe(1);
    expect((await state(id))[0].attempts).toBe(2);
    expect((await state(id))[0].output).toEqual({ receipt: "saved" });
    await pool.query("DELETE FROM effects WHERE key=$1", [`${id}:effect`]);
  });
  it("rolls back failed database effects and allows a clean retry", async () => {
    const e = new Engine(pool, []),
      key = `rollback-${Date.now()}`;
    await expect(
      e.effect(key, async (tx) => {
        await tx.query("INSERT INTO effects(key,output) VALUES($1,$2)", [
          key + "-inner",
          "null",
        ]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      (
        await pool.query("SELECT * FROM effects WHERE key=ANY($1)", [
          [key, key + "-inner"],
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("refuses changed definitions instead of running the wrong step", async () => {
    const e = new Engine(pool, [
      workflow([
        {
          name: "original",
          async run() {
            return null;
          },
        },
      ]),
    ]);
    await enqueue(e);
    await expect(
      new Engine(pool, [
        workflow([
          {
            name: "renamed",
            async run() {
              return null;
            },
          },
        ]),
      ]).tick(),
    ).rejects.toThrow("changed");
  });
});
