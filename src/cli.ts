import { database, migrate } from "./db.js";
import { Engine } from "./engine.js";
import { documentWorkflow } from "./workflows.js";
const pool = database(),
  engine = new Engine(pool, [documentWorkflow]);
try {
  const command = process.argv[2];
  if (command === "migrate") {
    await migrate(pool);
    console.log("Schema ready");
  } else if (command === "enqueue")
    console.log(
      await engine.enqueue(
        "document-report",
        JSON.parse(process.argv[3] ?? "{}"),
      ),
    );
  else if (command === "requeue" && process.argv[3]) {
    await engine.requeue(process.argv[3]);
    console.log("Requeued");
  } else
    throw new Error("Usage: cli.ts migrate | enqueue [JSON] | requeue RUN_ID");
} finally {
  await pool.end();
}
