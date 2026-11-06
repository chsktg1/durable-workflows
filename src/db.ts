import pg from "pg";
export function database() {
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/durable_workflows",
    max: 20,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", (error) =>
    console.error("idle database connection:", error.message),
  );
  return pool;
}
export async function migrate(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id uuid PRIMARY KEY, workflow text NOT NULL, version integer NOT NULL,
      input jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','dead_letter')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS steps (
      run_id uuid REFERENCES runs(id) ON DELETE CASCADE, position integer NOT NULL, name text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
      output jsonb, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL,
      base_delay_ms integer NOT NULL, available_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz, finished_at timestamptz, error text,
      PRIMARY KEY(run_id,position), UNIQUE(run_id,name)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id bigserial PRIMARY KEY, run_id uuid NOT NULL, position integer NOT NULL,
      number integer NOT NULL, worker text NOT NULL, status text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error text,
      FOREIGN KEY(run_id,position) REFERENCES steps(run_id,position) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS effects (
      key text PRIMARY KEY, output jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reports (
      idempotency_key text PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS runs_queue ON runs(created_at) WHERE status IN ('pending','running');
    CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id,position);
  `);
}
