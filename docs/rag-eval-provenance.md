# RAG Eval Harness integration

`src/eval.ts` ports the checks in the owner's existing
[rag-eval-harness](https://github.com/chsktg1/rag-eval-harness), specifically
`rag_eval/evaluate.py` and `rag_eval/textutil.py`, inspected from the supplied
`rag-eval-harness.zip` archive on November 6, 2026.

The port retains `retrieval_hit`, `used_evidence`, `has_source`,
`has_expected`, and `grounded`; the 0.8 unique-token overlap threshold;
normalization, stopwords, crude stemming; all six original flags; and the
original unanswerable rule (no cited sources counts as abstention).
Unit tests exercise passing checks, failure flags, wrong citations, and abstention.

This pipeline evaluates a cited summary rather than running the original
question-answer generator. Its retrieved context is the extracted document,
not a vector-search top-k. Expected evidence/keywords must be independently
supplied for custom documents. The built-in sample has an authored eval case.
Custom documents with no eval cases produce `total: 0, allPassed: false`;
this is not represented as a successful quality evaluation.

These are lexical checks. High overlap does not establish semantic factuality,
and an extractive summary naturally scores well on grounding. Evaluation flags
are report data, not infrastructure exceptions; failed checks still produce a
stored report. The deliberately injected `failEvaluation` exception exercises
retry/dead-letter behavior, not summary scoring.
