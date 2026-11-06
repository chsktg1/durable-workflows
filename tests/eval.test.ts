import { it, expect } from "vitest";
import { evaluate, tokens } from "../src/eval.js";
import { sampleCase, sampleDocument } from "../src/workflows.js";
const chunks = [{ id: "one", source: "document", text: sampleDocument }];
it("retains harness checks for a grounded cited answer", () => {
  expect(
    evaluate(
      sampleCase,
      "Durable workflows checkpoint each completed step to PostgreSQL.",
      ["one"],
      chunks,
    ),
  ).toMatchObject({
    passed: true,
    checks: {
      retrieval_hit: true,
      used_evidence: true,
      has_source: true,
      has_expected: true,
      grounded: true,
    },
  });
});
it("flags absent/wrong citations, missing evidence, keywords, and hallucinations", () => {
  expect(
    evaluate(sampleCase, "Unicorns fly on Mars.", ["bad"], []).flags,
  ).toEqual([
    "RETRIEVAL_MISS",
    "WRONG_SOURCE",
    "MISSING_EXPECTED",
    "UNGROUNDED",
  ]);
  expect(evaluate(sampleCase, "hello", [], chunks).flags).toEqual([
    "NO_SOURCE",
    "MISSING_EXPECTED",
  ]);
});
it("retains harness unanswerable abstention semantics", () => {
  expect(
    evaluate({ ...sampleCase, answerable: false }, "Unknown", [], chunks)
      .passed,
  ).toBe(true);
  expect(
    evaluate({ ...sampleCase, answerable: false }, "Answer", ["one"], chunks)
      .flags,
  ).toEqual(["ANSWERED_UNANSWERABLE"]);
});
it("ports crude stemming and stopword handling", () => {
  expect(tokens("The policies running saved classes")).toEqual([
    "policy",
    "run",
    "sav",
    "class",
  ]);
});
