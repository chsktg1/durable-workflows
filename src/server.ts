import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { database } from "./db.js";
import { Engine } from "./engine.js";
import { documentWorkflow } from "./workflows.js";
const pool = database(),
  engine = new Engine(pool, [documentWorkflow]);
const app = express();
app.use(express.json({ limit: "100kb" }));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.param("id", (req, res, next, id) => {
  if (!uuid.test(id)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }
  next();
});
app.get("/api/runs", async (req, res) => {
  const dead = req.query.status === "dead_letter";
  const result = await pool.query(
    `SELECT r.*, (SELECT count(*)::int FROM steps s WHERE s.run_id=r.id AND s.status='done') AS completed,(SELECT count(*)::int FROM steps s WHERE s.run_id=r.id) AS total FROM runs r ${dead ? "WHERE r.status='dead_letter'" : ""} ORDER BY created_at DESC LIMIT 100`,
  );
  res.json(result.rows);
});
app.get("/api/runs/:id", async (req, res) => {
  const r = await pool.query("SELECT * FROM runs WHERE id=$1", [req.params.id]);
  if (!r.rowCount) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const steps = await pool.query(
    "SELECT * FROM steps WHERE run_id=$1 ORDER BY position",
    [req.params.id],
  );
  const attempts = await pool.query(
    "SELECT * FROM attempts WHERE run_id=$1 ORDER BY id",
    [req.params.id],
  );
  const report = await pool.query(
    "SELECT report FROM reports WHERE run_id=$1",
    [req.params.id],
  );
  res.json({
    ...r.rows[0],
    steps: steps.rows,
    attempts: attempts.rows,
    report: report.rows[0]?.report ?? null,
  });
});
app.post("/api/runs", async (req, res) => {
  const mode = req.body?.mode;
  if (!["sample", "dead-letter"].includes(mode)) {
    res.status(400).json({ error: "mode must be sample or dead-letter" });
    return;
  }
  const id = await engine.enqueue(
    "document-report",
    mode === "dead-letter" ? { failEvaluation: true } : {},
  );
  res.status(201).json({ id });
});
app.post("/api/runs/:id/requeue", async (req, res) => {
  try {
    await engine.requeue(req.params.id as string);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown API route" }),
);
const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
app.use(express.static(dist));
app.get("/{*path}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err.message);
    res.status(500).json({ error: "Request failed" });
  },
);
const server = app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () =>
  console.log(`Dashboard/API: http://127.0.0.1:${process.env.PORT ?? 3000}`),
);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () =>
    server.close(() => {
      void pool.end();
    }),
  );
