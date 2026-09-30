/**
 * Unit tests for the LongMemEval harness.
 *
 * Run with:  node --test evals/longmemeval/test/
 *
 * These cover the parts that are easy to get subtly wrong and that a full run
 * would only reveal as an unexplained number: the metric port's edge cases,
 * the official gold rule, the keyword/summary strategies, the .mem entry → LLM
 * context formatting, and the two ingest branches (deterministic and LLM).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCorpus, buildRankings } from "../lib/dataset.mjs";
import { evaluateRetrieval, evaluateRetrievalTurn2Session, dcg, stripTurnId } from "../lib/metrics.mjs";
import { aggregate } from "../lib/metrics.mjs";
import { formatMemory } from "../lib/format.mjs";
import {
  contentTokens,
  corpusStats,
  idfFromDf,
  ingestKeywords,
  extractiveSummary,
  queryKeywords,
  sanitizeForEngine,
  bm25Rank,
  titleize,
  summarize
} from "../lib/text.mjs";
import { describeItem } from "../lib/ingest.mjs";

// ── metrics ─────────────────────────────────────────────────────────────────

test("dcg matches the upstream arithmetic", () => {
  assert.equal(dcg([], 10), 0);
  assert.equal(dcg([1], 10), 1);
  // first term undiscounted, second divided by log2(2) == 1
  assert.equal(dcg([1, 1], 10), 2);
  // third divided by log2(3)
  assert.ok(Math.abs(dcg([1, 1, 1], 10) - (2 + 1 / Math.log2(3))) < 1e-12);
});

test("evaluateRetrieval: recall_any/recall_all/ndcg on a hand-checked case", () => {
  const corpus = ["answer_a", "filler_b", "answer_c", "filler_d"];
  const gold = new Set(["answer_a", "answer_c"]);
  // ranking index 0 (answer_a) then 1 (filler_b)
  const r = evaluateRetrieval([0, 1, 2, 3], gold, corpus, 2);
  assert.equal(r.recallAny, 1);
  assert.equal(r.recallAll, 0); // answer_c is not in the top 2
  const perfect = evaluateRetrieval([0, 2, 1, 3], gold, corpus, 2);
  assert.equal(perfect.recallAll, 1);
  assert.equal(perfect.ndcg, 1);
});

test("empty gold set follows upstream: recall_any=0, recall_all=1, ndcg=0", () => {
  const corpus = ["filler_a", "filler_b"];
  const r = evaluateRetrieval([0, 1], new Set(), corpus, 5);
  assert.equal(r.recallAny, 0); // any([]) is False
  assert.equal(r.recallAll, 1); // all([]) is True
  assert.equal(r.ndcg, 0); // ideal DCG is 0
});

test("turn→session collapse widens k to cover k distinct sessions", () => {
  // Real ids look like `<session>_<turn>`; stripTurnId drops the trailing turn
  // segment, so the gold id must carry one too.
  assert.equal(stripTurnId("answer_abc_7"), "answer_abc");
  assert.equal(stripTurnId("sharegpt_x_0"), "sharegpt_x");
  const corpus = ["s1_1", "s1_2", "s1_3", "answer_s2_1", "filler_s3_1"];
  // The top two RANKS are both in one session, so k=2 must widen until two
  // distinct sessions are covered before the gold session is counted.
  const r = evaluateRetrievalTurn2Session([0, 1, 3, 2, 4], new Set(["answer_s2_1"]), corpus, 2);
  assert.equal(r.recallAll, 1);
  // Not widening would have missed it: rank 3 is outside the naive top 2.
  const naive = evaluateRetrieval([0, 1, 3, 2, 4], new Set(["answer_s2"]), ["s1", "s1", "s1", "answer_s2", "filler_s3"], 2);
  assert.equal(naive.recallAll, 0);
});

test("buildRankings appends the unseen corpus so NDCG sees the full index", () => {
  const corpus = ["a", "b", "c", "d"];
  const rankings = buildRankings(["c", "a"], corpus);
  assert.deepEqual(rankings, [2, 0, 1, 3]);
  // unknown ids and duplicates are ignored
  assert.deepEqual(buildRankings(["c", "nope", "c"], corpus), [2, 0, 1, 3]);
});

// ── dataset / gold rule ─────────────────────────────────────────────────────

function instance(overrides) {
  return {
    question_id: "q1",
    question_type: "single-session-user",
    question: "What is my cat called?",
    answer: "Miso",
    question_date: "2024-01-01",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: [],
    ...overrides
  };
}

test("gold requires BOTH the answer id marker and a flagged user turn", () => {
  const entry = instance({
    haystack_session_ids: ["answer_a_1", "answer_b_2", "filler_c_3"],
    haystack_dates: ["d1", "d2", "d3"],
    haystack_sessions: [
      [{ role: "user", content: "my cat is Miso", has_answer: true }],
      [{ role: "user", content: "unrelated", has_answer: false }],
      [{ role: "user", content: "filler", has_answer: false }]
    ],
    answer_session_ids: ["answer_a_1", "answer_b_2"]
  });
  const corpus = buildCorpus(entry, "session");
  // answer_b_2 has the id marker but no flagged turn → relabelled "noans"
  assert.deepEqual(corpus.corpusIds, ["answer_a_1", "noans_b_2", "filler_c_3"]);
  assert.deepEqual(corpus.goldIds, ["answer_a_1"]);
});

test("session granularity indexes user turns only; assistant-only session is empty", () => {
  const entry = instance({
    haystack_session_ids: ["filler_a", "filler_b"],
    haystack_dates: ["d1", "d2"],
    haystack_sessions: [
      [
        { role: "user", content: "hello there" },
        { role: "assistant", content: "assistant words" }
      ],
      [{ role: "assistant", content: "only assistant" }]
    ]
  });
  const corpus = buildCorpus(entry, "session");
  assert.equal(corpus.texts[0], "hello there");
  assert.equal(corpus.texts[1], "", "assistant turns must not enter the session text");
  // ...but the ingest fallback keeps the transcript so a memory can still be written
  assert.equal(corpus.slots[1].fallbackText, "only assistant");
});

test("turn granularity numbers turns over ALL turns and relabels non-gold ones", () => {
  const entry = instance({
    haystack_session_ids: ["answer_a_1"],
    haystack_dates: ["d1"],
    haystack_sessions: [
      [
        { role: "user", content: "first", has_answer: false },
        { role: "assistant", content: "reply" },
        { role: "user", content: "the fact", has_answer: true },
        { role: "user", content: "later", has_answer: false }
      ]
    ]
  });
  const corpus = buildCorpus(entry, "turn");
  // 1-based index over all turns, assistant turns skipped
  assert.deepEqual(corpus.corpusIds, ["noans_a_1_1", "answer_a_1_3", "noans_a_1_4"]);
  assert.deepEqual(corpus.goldIds, ["answer_a_1_3"]);
});

// ── text strategies ─────────────────────────────────────────────────────────

test("tokenize/stopwords drop function words but keep CJK runs", () => {
  assert.deepEqual(contentTokens("I was going to the beach"), ["beach"]);
  assert.deepEqual(contentTokens("我养了一只猫 named Miso"), ["我养了一只猫", "named", "miso"]);
});

test("idfFromDf gives a rarer term a higher weight", () => {
  const idf = idfFromDf(new Map([["rare", 1], ["common", 50]]), 50);
  assert.ok(idf.get("rare") > idf.get("common"));
});

test("tf saturation compresses the advantage of repetition so IDF decides", () => {
  // Saturation does not make any once-mentioned term beat any repeated one —
  // it caps how much repetition alone can buy, so a distinctive term can win.
  // Here a 2× common term (idf 1.0) outranks a rare term (idf 1.6) under plain
  // tf×idf, but loses once tf is saturated:
  //   tfidf : common 2 × 1.0 = 2.00   rare 1 × 1.6 = 1.60  -> common
  //   bm25  : common (2×2.2)/(2+1.2) × 1.0 = 1.375        -> rare
  const stats = { idf: new Map([["common", 1.0], ["raret", 1.6]]), n: 10 };
  const text = "common common raret";
  assert.equal(ingestKeywords(text, stats, 1, { score: "tfidf" })[0], "common");
  assert.equal(ingestKeywords(text, stats, 1, { score: "bm25" })[0], "raret");
});

test("tf saturation converges to a bounded multiplier as tf grows", () => {
  // The saturated weight (tf × (k1+1)) / (tf + k1) is bounded by k1+1 = 2.2, so
  // repetition alone can never beat a term whose IDF exceeds that ceiling. A
  // term repeated 51 times scores ≈2.149, below an IDF-2.5 single mention.
  const stats = { idf: new Map([["word", 1.0], ["zebra", 2.5]]), n: 10 };
  const text = `word ${"word ".repeat(50)}zebra`;
  assert.equal(ingestKeywords(text, stats, 1, { score: "bm25" })[0], "zebra", "1 idf × 51 repeats ≈ 2.149 < 2.5");
  assert.equal(ingestKeywords(text, stats, 1, { score: "tfidf" })[0], "word", "unsaturated tf×idf is swamped by repetition (51 > 2.5)");
});

test("ingestKeywords always yields at least the 2 keywords mem_write requires", () => {
  assert.ok(ingestKeywords("", { idf: new Map(), n: 1 }, 12).length >= 2);
  assert.ok(ingestKeywords("hi", { idf: new Map(), n: 1 }, 12).length >= 2);
});

test("extractiveSummary reaches evidence that a prefix truncation cuts off", () => {
  const stats = corpusStats(["x"]);
  const deep = `${"filler words here. ".repeat(30)}I graduated with a degree in Business Administration.`;
  const prefix = summarize(deep, 400);
  const extractive = extractiveSummary(deep, stats, { sentences: 4, maxChars: 900 });
  assert.ok(!prefix.includes("Business Administration"), "prefix summary should miss the late fact");
  assert.ok(extractive.includes("Business Administration"), "extractive summary should keep it");
});

test("extractiveSummary is deterministic and never empty for non-empty text", () => {
  const stats = corpusStats(["a b c"]);
  const text = "One sentence here. Another sentence there. A third one.";
  assert.equal(extractiveSummary(text, stats), extractiveSummary(text, stats));
  assert.ok(extractiveSummary("no terminal punctuation", stats).length > 0);
});

test("sanitizeForEngine strips exactly what the engine rejects, keeping tab/LF/CR", () => {
  const dirty = `a\u0000b\u0007c\u001fd\u007fe`;
  assert.equal(sanitizeForEngine(dirty), "abcde");
  assert.equal(sanitizeForEngine("keep\ttabs\nand\rnewlines"), "keep\ttabs\nand\rnewlines");
});

test("queryKeywords returns at least one term even for a stopword-only question", () => {
  const kws = queryKeywords("what is it", undefined, "plain", 15);
  assert.ok(kws.length >= 1);
});

test("bm25Rank prefers the document containing the rare query term", () => {
  const corpus = ["the cat sat on the mat", "a uniquely specific fact about llamas", "more filler text here"];
  const ranked = bm25Rank("llamas", corpus);
  assert.equal(ranked[0], 1);
});

test("titleize is single-line and bounded", () => {
  const t = titleize("a\nb\r\nc ".repeat(60));
  assert.ok(!/[\r\n]/.test(t));
  assert.ok(t.length <= 190);
});

// ── entry formatting ────────────────────────────────────────────────────────

test("formatMemory strips front matter and the generated skeleton", () => {
  const raw = [
    "---",
    'gitmemo_version: "2"',
    "date: 2024-01-01T00:00:00.000Z",
    "keywords: []",
    "---",
    "",
    "# [session] hello",
    "",
    "## Summary",
    "",
    "the summary line",
    "",
    "## Final Outcome",
    "",
    "**user:** the body",
    ""
  ].join("\n");
  const out = formatMemory(raw);
  assert.ok(!out.includes("gitmemo_version"));
  assert.ok(out.includes("### [session] hello"));
  assert.ok(out.includes("the summary line"));
  assert.ok(out.includes("**user:** the body"));
});

test("formatMemory drops a summary that the body already contains", () => {
  const raw = [
    "---",
    "kind: \"task\"",
    "---",
    "",
    "# t",
    "",
    "## Summary",
    "",
    "the summary line",
    "",
    "## Final Outcome",
    "",
    "the summary line and more",
    ""
  ].join("\n");
  const out = formatMemory(raw);
  assert.equal(out.match(/the summary line/g).length, 1);
});

test("formatMemory degrades gracefully on a body without sections", () => {
  assert.equal(formatMemory("just text"), "just text");
  assert.equal(formatMemory(""), "");
});

// ── ingest branches ─────────────────────────────────────────────────────────

const fakeClient = (payload) => ({
  ready: true,
  async chatJson() {
    return payload;
  }
});

test("describeItem (idf) produces mem_write-legal metadata", async () => {
  const stats = corpusStats(["some corpus text"]);
  const item = { docId: "d", text: "I adopted a golden retriever puppy named Biscuit.", content: "c" };
  const fields = await describeItem(item, { ingestMode: "idf", stats, maxKeywords: 12 });
  assert.ok(fields.title.trim().length > 0);
  assert.ok(!/[\r\n]/.test(fields.title));
  assert.ok(fields.summary.trim().length > 0);
  assert.ok(fields.keywords.length >= 2 && fields.keywords.length <= 12);
});

test("describeItem (llm) accepts the model's metadata and sanitizes it", async () => {
  const stats = corpusStats(["x"]);
  const item = { docId: "d", text: "some session text about llamas", content: "c" };
  const client = fakeClient({
    title: "llama care\u0007",
    summary: "The user keeps llamas\u0000.",
    keywords: ["llamas", "feeding"]
  });
  const fields = await describeItem(item, { ingestMode: "llm", stats, client, maxKeywords: 12 });
  assert.equal(fields.title, "llama care");
  assert.equal(fields.summary, "The user keeps llamas.");
  assert.deepEqual(fields.keywords, ["llamas", "feeding"]);
});

test("describeItem (llm) falls back to the heuristic when the model returns junk", async () => {
  const stats = corpusStats(["x"]);
  const item = { docId: "d", text: "a session about llamas and feeding schedules", content: "c" };
  const client = fakeClient({ keywords: ["only-one"] }); // fewer than 2 → fallback
  const fields = await describeItem(item, { ingestMode: "llm", stats, client, maxKeywords: 12 });
  assert.ok(fields.keywords.length >= 2);
  assert.ok(fields.summary.trim().length > 0);
  assert.ok(!/undefined/.test(fields.title));
});

test("describeItem (llm) throws a clear error without a usable client", async () => {
  const stats = corpusStats(["x"]);
  const item = { docId: "d", text: "text", content: "c" };
  await assert.rejects(
    () => describeItem(item, { ingestMode: "llm", stats, client: { ready: false } }),
    /requires an API key/
  );
});

test("describeItem uses the transcript fallback when the user-only text is empty", async () => {
  const stats = corpusStats(["x"]);
  const item = { docId: "d", text: "", fallbackText: "assistant only words here", content: "c" };
  const fields = await describeItem(item, { ingestMode: "idf", stats, maxKeywords: 12 });
  assert.ok(fields.summary.trim().length > 0);
  assert.ok(fields.summary.includes("assistant"));
});

// ── aggregation ─────────────────────────────────────────────────────────────

test("aggregate excludes abstention and reports gold-free counts", () => {
  const block = (v) => ({
    session: { "recall_all@5": v, "recall_any@5": v, "ndcg_any@5": v },
    turn: {}
  });
  const records = [
    { question_id: "a", question_type: "t1", gold_count: 2, metrics: block(1) },
    { question_id: "b", question_type: "t1", gold_count: 0, metrics: block(0) },
    { question_id: "c_abs", question_type: "t2", gold_count: 0, metrics: block(0) }
  ];
  const out = aggregate(records);
  assert.equal(out.overall.n, 2, "abstention instance must be excluded from the means");
  assert.equal(out.overall.session["recall_all@5"], 0.5);
  assert.equal(out.types.t1.n, 2);
  assert.equal(out.types.t1.gold_free, 1);
  assert.equal(out.abstention.n, 1);
  assert.equal(out.gold_free_non_abstention, 1);
  assert.equal(out.overall.session["ndcg_any@5"], 0.5);
});
