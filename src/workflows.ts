import { setTimeout as sleep } from "node:timers/promises";
import type { Workflow } from "./engine.js";
import { evaluate, type Chunk, type EvalCase } from "./eval.js";
export const sampleDocument = `Durable workflows checkpoint each completed step to PostgreSQL. Workers claim queued work using SKIP LOCKED. Failed steps retry with exponential backoff. Exhausted runs enter a dead-letter queue for manual requeue. Stable idempotency keys prevent duplicate database reports.`;
export const sampleCase: EvalCase = {
  id: "checkpoint",
  question: "How are completed steps persisted?",
  answerable: true,
  expected_source: "document",
  expected_evidence: "checkpoint each completed step",
  expected_keywords: ["checkpoint", "PostgreSQL"],
};
interface Input {
  url?: string;
  text?: string;
  evalCases?: EvalCase[];
  crashDemo?: boolean;
  failEvaluation?: boolean;
}
export const documentWorkflow: Workflow = {
  name: "document-report",
  version: 1,
  steps: [
    {
      name: "fetch",
      async run({ input, signal }) {
        const { url, text } = input as Input;
        if (!url) return { source: "document", text: text ?? sampleDocument };
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error("Only HTTP(S) document URLs are supported");
        const response = await fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error(`Fetch HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty response");
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2_000_000) throw new Error("Document exceeds 2 MB");
            parts.push(value);
          }
        } finally {
          await reader.cancel();
        }
        return { source: url, text: Buffer.concat(parts).toString("utf8") };
      },
    },
    {
      name: "extract",
      async run({ outputs }) {
        const doc = outputs.fetch as { source: string; text: string };
        // Text/HTML extraction; PDFs deliberately require a separate adapter.
        const text = doc.text
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) throw new Error("Document contains no extractable text");
        const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
        return sentences.map((text, i) => ({
          id: `chunk-${i + 1}`,
          source: doc.source,
          text: text.trim(),
        }));
      },
    },
    {
      name: "summarize",
      async run({ outputs }) {
        const chunks = outputs.extract as unknown as Chunk[];
        // Deterministic extractive summary: reproducible offline and no paid API key required.
        const selected = chunks.slice(0, 3);
        return {
          answer: selected.map((c) => c.text).join(" "),
          sources: selected.map((c) => c.id),
          method: "extractive-first-three-sentences",
        };
      },
    },
    {
      name: "evaluate",
      baseDelayMs: 500,
      async run({ input, outputs }) {
        const config = input as Input;
        if (config.failEvaluation)
          throw new Error("Requested evaluation failure (dead-letter demo)");
        const summary = outputs.summarize as {
          answer: string;
          sources: string[];
        };
        const chunks = outputs.extract as unknown as Chunk[];
        // Custom documents should supply independently authored expected evidence.
        const cases =
          config.evalCases ?? (config.url || config.text ? [] : [sampleCase]);
        const results = cases.map((item) =>
          evaluate(item, summary.answer, summary.sources, chunks),
        );
        return {
          results,
          passed: results.filter((r) => r.passed).length,
          total: results.length,
          allPassed: results.length > 0 && results.every((r) => r.passed),
        };
      },
    },
    {
      name: "store-report",
      async run(ctx) {
        const output = await ctx.effect(async (tx) => {
          const report = {
            summary: ctx.outputs.summarize,
            evaluation: ctx.outputs.evaluate,
          };
          await tx.query(
            "INSERT INTO reports(idempotency_key,run_id,report) VALUES($1,$2,$3)",
            [ctx.idempotencyKey, ctx.runId, JSON.stringify(report)],
          );
          return { reportKey: ctx.idempotencyKey };
        });
        if ((ctx.input as Input).crashDemo && ctx.attempt === 1) {
          console.log(
            `EFFECT_COMMITTED ${ctx.idempotencyKey}; pausing before checkpoint`,
          );
          await sleep(60_000, undefined, { signal: ctx.signal });
        }
        return output;
      },
    },
  ],
};
