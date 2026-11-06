// TypeScript port of rag-eval-harness/rag_eval/{evaluate,textutil}.py.
// Retains the original lexical checks, flags, stopwords and crude stemming.
const stop = new Set(
  `a an the is are was were be been do does did i you we my me our your of to for in on at by with and or but what which who whom when where how why can could would should will may might much many long it its any there this that these those from after before have has had not if as so than then also about into only up out get gets got`.split(
    " ",
  ),
);
function stem(w: string) {
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss"))
    w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length > 3 && w.at(-1) === w.at(-2) && !"aeiouls".includes(w.at(-1)!))
    w = w.slice(0, -1);
  return w;
}
export const tokens = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => !stop.has(w) && (w.length >= 2 || /^\d$/.test(w)))
    .map(stem);
export interface Chunk {
  id: string;
  source: string;
  text: string;
}
export interface EvalCase {
  id: string;
  question: string;
  answerable: boolean;
  expected_source: string;
  expected_evidence: string;
  expected_keywords: string[];
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export function evaluate(
  item: EvalCase,
  answer: string,
  sources: string[],
  chunks: Chunk[],
) {
  const flags: string[] = [];
  const checks: Record<string, boolean> = { has_source: sources.length > 0 };
  if (item.answerable) {
    const hits = chunks
      .filter(
        (c) =>
          c.source === item.expected_source &&
          norm(c.text).includes(norm(item.expected_evidence)),
      )
      .map((c) => c.id);
    const words = new Set(tokens(answer)),
      context = new Set(chunks.flatMap((c) => tokens(c.text)));
    checks.retrieval_hit = hits.length > 0;
    checks.used_evidence = sources.some((s) => hits.includes(s));
    checks.has_expected = item.expected_keywords.every((k) =>
      answer.toLowerCase().includes(k.toLowerCase()),
    );
    checks.grounded =
      sources.length > 0 &&
      words.size > 0 &&
      [...words].filter((w) => context.has(w)).length / words.size >= 0.8;
    if (!checks.retrieval_hit) flags.push("RETRIEVAL_MISS");
    if (!checks.has_source) flags.push("NO_SOURCE");
    else if (!checks.used_evidence) flags.push("WRONG_SOURCE");
    if (!checks.has_expected) flags.push("MISSING_EXPECTED");
    if (checks.has_source && !checks.grounded) flags.push("UNGROUNDED");
  } else if (sources.length) flags.push("ANSWERED_UNANSWERABLE");
  return {
    id: item.id,
    question: item.question,
    answerable: item.answerable,
    answer,
    sources,
    retrieved: chunks.map((c) => c.id),
    checks,
    flags,
    passed: flags.length === 0,
  };
}
