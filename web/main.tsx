import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Run = {
  id: string;
  workflow: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed: number;
  total: number;
};
type Step = {
  name: string;
  position: number;
  status: string;
  attempts: number;
  max_attempts: number;
  started_at: string | null;
  finished_at: string | null;
  available_at: string;
  error: string | null;
  output: unknown;
};
type Attempt = {
  id: number;
  position: number;
  number: number;
  worker: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
};
type Detail = Run & { steps: Step[]; attempts: Attempt[]; report: unknown };
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch("/api" + path, init);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "Request failed");
  return body;
}
const stamp = (s: string | null) =>
  s
    ? new Date(s).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const label = (s: string) => s.replaceAll("_", " ");
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {label(status)}
    </span>
  );
}
function App() {
  const [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [view, setView] = useState("all"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await api<Run[]>("/runs");
        const d = selected ? await api<Detail>("/runs/" + selected) : null;
        if (!cancelled) {
          setRuns(list);
          setDetail(d);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void refresh();
    const t = setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selected]);
  async function launch(mode: string) {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      setSelected(r.id);
      setDetail(null);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function requeue() {
    if (!selected) return;
    setBusy(true);
    try {
      await api("/runs/" + selected + "/requeue", { method: "POST" });
      setDetail(await api<Detail>("/runs/" + selected));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = runs.filter(
    (r) => view === "all" || r.status === "dead_letter",
  );
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          ◈{" "}
          <span>
            durable<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace">
          WORKSPACE <span>LOCAL</span>
        </div>
        <nav>
          <button
            className={view === "all" ? "active" : ""}
            onClick={() => setView("all")}
          >
            ▦ <span>Workflow runs</span>
            <small>{runs.length}</small>
          </button>
          <button
            className={view === "dead" ? "active" : ""}
            onClick={() => setView("dead")}
          >
            ◇ <span>Dead letters</span>
            <small>
              {runs.filter((r) => r.status === "dead_letter").length}
            </small>
          </button>
        </nav>
        <div className="aside-note">
          <span className="green-dot" /> POSTGRES BACKED
          <p>
            Every completed step
            <br />
            is a durable checkpoint.
          </p>
          <code>document-report @ v1</code>
        </div>
        <footer>SMALL ENGINE. DURABLE WORK.</footer>
      </aside>
      <main>
        <header>
          <span>
            Workspace <b>/</b> Workflows <b>/</b>{" "}
            {view === "all" ? "All runs" : "Dead letters"}
          </span>
          <span className="live">
            <i /> Live · 1.5s
          </span>
        </header>
        <section className="content">
          <div className="title-row">
            <div className="eyebrow">EXECUTION CONSOLE</div>
            <div className="heading">
              <div>
                <h1>{view === "all" ? "Workflow runs" : "Dead letters"}</h1>
                <p>
                  Code executes. Progress persists. Pick up where you left off.
                </p>
              </div>
              <div className="actions">
                <button
                  disabled={busy}
                  className="subtle"
                  onClick={() => launch("dead-letter")}
                >
                  Test failure
                </button>
                <button
                  disabled={busy}
                  className="primary"
                  onClick={() => launch("sample")}
                >
                  ＋ New sample run
                </button>
              </div>
            </div>
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <div className="stats">
            {[
              ["Total runs", runs.length],
              [
                "In progress",
                runs.filter((r) => ["pending", "running"].includes(r.status))
                  .length,
              ],
              ["Completed", runs.filter((r) => r.status === "done").length],
              [
                "Dead letters",
                runs.filter((r) => r.status === "dead_letter").length,
              ],
            ].map(([name, n], i) => (
              <div key={name}>
                <span>{name}</span>
                <strong>{String(n).padStart(2, "0")}</strong>
                <em>{["↗", "◌", "✓", "◇"][i]}</em>
              </div>
            ))}
          </div>
          <div className="panels">
            <section className="run-panel">
              <div className="panel-head">
                <h2>
                  {view === "all" ? "Recent executions" : "Needs attention"}
                </h2>
                <span>{visible.length} runs · latest 100</span>
              </div>
              <div className="table-head">
                <span>WORKFLOW / RUN</span>
                <span>STATUS</span>
              </div>
              <div className="run-list">
                {visible.length === 0 ? (
                  <div className="empty">
                    No runs here yet.
                    <p>Launch a sample to watch each checkpoint.</p>
                  </div>
                ) : (
                  visible.map((r) => (
                    <button
                      key={r.id}
                      className={`run ${selected === r.id ? "selected" : ""}`}
                      onClick={() => {
                        setSelected(r.id);
                        setDetail(null);
                      }}
                    >
                      <div>
                        <strong>{r.workflow}</strong>
                        <code>{r.id.slice(0, 8)}</code>
                        <span className="run-time">
                          {stamp(r.created_at)} · {r.completed}/{r.total} steps
                        </span>
                      </div>
                      <Badge status={r.status} />
                    </button>
                  ))
                )}
              </div>
            </section>
            <section className="detail-panel">
              <div className="panel-head">
                <h2>Execution timeline</h2>
                <span>ORDERED STEPS</span>
              </div>
              {!detail ? (
                <div className="empty large">
                  <div className="empty-icon">⌁</div>
                  {selected ? "Loading run…" : "Select an execution"}
                  <p>Inspect checkpoints, retries, and outputs.</p>
                </div>
              ) : (
                <>
                  <div className="detail-summary">
                    <div>
                      <code>{detail.id}</code>
                      <p>
                        Started {new Date(detail.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Badge status={detail.status} />
                  </div>
                  {detail.status === "dead_letter" && (
                    <div className="dead-notice">
                      <strong>Retry budget exhausted</strong>
                      <p>
                        Requeue retries the failed step with a fresh budget.
                        Completed checkpoints and idempotency keys persist. A
                        deterministic failure requires a code or dependency fix
                        first.
                      </p>
                      <button disabled={busy} onClick={requeue}>
                        ↻ Requeue run
                      </button>
                    </div>
                  )}
                  <ol className="timeline">
                    {detail.steps.map((s) => (
                      <li key={s.name} className={s.status}>
                        <div className="step-mark">
                          {s.status === "done"
                            ? "✓"
                            : String(s.position + 1).padStart(2, "0")}
                        </div>
                        <div className="step-body">
                          <div className="step-title">
                            <h3>{s.name}</h3>
                            <Badge status={s.status} />
                          </div>
                          <div className="step-meta">
                            {s.attempts}/{s.max_attempts} attempts{" "}
                            <span>·</span> {stamp(s.started_at)} →{" "}
                            {stamp(s.finished_at)}
                          </div>
                          {s.status === "failed" &&
                            detail.status !== "dead_letter" && (
                              <p className="retry-time">
                                Retry eligible {stamp(s.available_at)}
                              </p>
                            )}
                          {s.error && (
                            <pre className="step-error">{s.error}</pre>
                          )}
                          {s.output !== null && (
                            <details>
                              <summary>Checkpoint output</summary>
                              <pre>{JSON.stringify(s.output, null, 2)}</pre>
                            </details>
                          )}
                          {detail.attempts
                            .filter((a) => a.position === s.position)
                            .map((a) => (
                              <div className="attempt" key={a.id}>
                                <code>
                                  #{a.number} {a.worker}
                                </code>
                                <span>
                                  {a.status} · {stamp(a.started_at)}
                                </span>
                                {a.error && <p>{a.error}</p>}
                              </div>
                            ))}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {detail.report != null && (
                    <div className="report">
                      <h3>Stored report</h3>
                      <pre>{JSON.stringify(detail.report, null, 2)}</pre>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
          <div className="bottom-note">
            <span>◈</span> At-least-once execution. Stable idempotency keys.
            Durable checkpoints.
          </div>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
