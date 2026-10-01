#!/usr/bin/env node
/**
 * System-one gate study: can the gate's false-drop rate be reduced?
 *
 * The pipeline factorial showed the gate as shipped is harmful on LongMemEval:
 * at threshold 0.5 with the plugin's defaults it drops 343 gold memories across
 * 254 of 500 instances, collapsing recall_all@5 from 0.755 to 0.377. This study
 * asks *why*, and which lever actually helps, by separating three factors that
 * the end-to-end number conflates:
 *
 *   REQUEST CONTENT  what text the judge sees. `buildRequest` sends only
 *                    title / summary / keywords — the entry BODY is never sent,
 *                    and LongMemEval's evidence is a detail buried in a
 *                    transcript of a topically unrelated session.
 *   REQUEST PHRASING the question asked. The shipped `NOUL_INSTRUCTION` asks
 *                    whether a memory holds "conclusions ... directly relevant to
 *                    the task" and explicitly answers no "when it is merely on a
 *                    related topic" — a question about reusing engineering
 *                    knowledge, not about answerability.
 *   DECISION RULE    what is done with the score. The shipped rule is a hard
 *                    filter at a threshold, which throws information away; a
 *                    reranking rule cannot lose evidence by construction.
 *
 * It records, for every candidate on page 1 of a real search, the judge's value
 * under each variant together with the ground-truth gold label. That makes the
 * decision-rule axis free to explore offline: any rule is a pure function of the
 * recorded values, so thresholds, reranking and tail-cutting cost no further
 * model calls.
 *
 * Usage:
 *   node evals/longmemeval/gate_study.mjs --split s --seed 5 --limit 80
 *   node evals/longmemeval/gate_study.mjs --split s --seed 5 --limit 80 --variants v0,v2
 *
 * Output: one JSON with the raw records plus the analysis, and a console report.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus, buildRankings, loadSplit } from "./lib/dataset.mjs";
import { computeMetrics, K_VALUES } from "./lib/metrics.mjs";
import { corpusStats, queryKeywords } from "./lib/text.mjs";
import { createMemoRoot, ingestInstance, GitMemo, removeMemoRoot, renderContent, searchHashes } from "./lib/ingest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");
const SPLITS = { oracle: "longmemeval_oracle.json", s: "longmemeval_s_cleaned.json" };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) args[token.slice(2, eq)] = token.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    } else args[token.slice(2)] = true;
  }
  return args;
}

/** The question the plugin ships today (mirrored from src/systemone.ts). */
const OBJECTIVE_QUESTION =
  "Does the `candidate` memory record contain conclusions, decisions, constraints, or reusable findings that are " +
  "directly relevant to the `task`? Answer yes only if reading that memory would inform or change how the task is " +
  "carried out. Answer no when it is merely on a related topic, is superseded, or concerns a different area.";

/**
 * The same judgement re-phrased for answerability. It asks whether the record
 * bears on the QUESTION at all — including a fact mentioned in passing — instead
 * of whether the record is reusable knowledge for the reader's own work.
 */
const ANSWERABILITY_QUESTION =
  "Does the `candidate` memory record contain any information that would help answer the `task`? Answer yes if a " +
  "fact stated anywhere in the candidate bears on the question being asked, even when the candidate's overall topic " +
  "is different, and even if the information appears only in passing. Answer no only when nothing in it could " +
  "contribute to answering the question.";

const baseUrl = String(process.env.GITMEMO_GATE_ENDPOINT ?? "http://127.0.0.1:8765/v1/systemone");
const apiKey = String(process.env.GITMEMO_GATE_API_KEY ?? "local");
const model = String(process.env.GITMEMO_GATE_MODEL ?? "laya-multilingual");

/** One raw System-one request; returns the value per candidate index. */
async function judge(task, candidates, question) {
  const questions = {};
  candidates.forEach((candidate, index) => {
    questions["m" + index] = {
      type: "noul",
      criteria: { true: "yes — it bears on the question", false: "no — it does not bear on the question" },
      instructions: { question, candidate }
    };
  });
  const started = Date.now();
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
    body: JSON.stringify({ state: { task: task }, model, questions })
  });
  if (!response.ok) throw new Error(`gate endpoint HTTP ${response.status}`);
  const payload = await response.json();
  const map = payload?.answers ?? payload ?? {};
  return {
    values: candidates.map((_, index) => {
      const answer = map["m" + index];
      const raw = answer?.noul ?? answer?.probability;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    }),
    latencyMs: Date.now() - started
  };
}

/** Split prose into ~`size`-character windows on sentence boundaries. */
function chunk(text, size) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= size) return [flat];
  const sentences = flat.split(/(?<=[.!?])\s+/);
  const out = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > size) {
      out.push(current);
      current = sentence;
    } else {
      current = current.length === 0 ? sentence : current + " " + sentence;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Rank-based AUC of `values` against `labels` (1 = gold). */
function auc(values, labels) {
  const pairs = values.map((value, index) => ({ value, label: labels[index] })).filter((p) => p.value !== null);
  const positives = pairs.filter((p) => p.label === 1);
  const negatives = pairs.filter((p) => p.label === 0);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p.value > n.value) wins += 1;
      else if (p.value === n.value) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

// ── variants ────────────────────────────────────────────────────────────────
// Each variant maps one candidate to the payload the judge receives, and names
// the question it is asked. `body` variants surface transcript text; the chunked
// variant asks the judge about short windows and keeps the best, because a long
// text dilutes the signal (see the README's length probe).
const VARIANTS = {
  v0_objective_projections: {
    label: "objective Q · projections (shipped)",
    question: OBJECTIVE_QUESTION,
    payloads: (c) => [{ title: c.title, summary: c.summary, keywords: c.keywords, kind: c.kind }]
  },
  v1_objective_body: {
    label: "objective Q · + 1200-char body excerpt",
    question: OBJECTIVE_QUESTION,
    payloads: (c) => [{ title: c.title, summary: (c.summary + " " + c.body).slice(0, 1200), keywords: c.keywords, kind: c.kind }]
  },
  v2_answerability_projections: {
    label: "answerability Q · projections",
    question: ANSWERABILITY_QUESTION,
    payloads: (c) => [{ title: c.title, summary: c.summary, keywords: c.keywords, kind: c.kind }]
  },
  v3_answerability_body: {
    label: "answerability Q · + 1200-char body excerpt",
    question: ANSWERABILITY_QUESTION,
    payloads: (c) => [{ title: c.title, summary: (c.summary + " " + c.body).slice(0, 1200), keywords: c.keywords, kind: c.kind }]
  },
  v4_answerability_chunkmax: {
    label: "answerability Q · chunked body, best window",
    question: ANSWERABILITY_QUESTION,
    chunked: true,
    chunkSize: 400,
    payloads: (c) => chunk(c.body, 400).slice(0, 6).map((piece) => ({
      title: c.title,
      summary: piece,
      keywords: c.keywords,
      kind: c.kind
    }))
  }
};

// ── decision rules ──────────────────────────────────────────────────────────
// All are pure functions of the recorded values, so they cost nothing to sweep.
const DECISIONS = {
  filter: (entries, opts) => entries.filter((e) => e.value !== null && e.value >= opts.threshold),
  rerank: (entries) => entries,
  rerank_tailcut: (entries, opts) => entries.filter((e) => e.value !== null && e.value >= opts.tail),
  keep_topN: (entries, opts) => entries.slice(0, opts.n),
  filter_then_cap: (entries, opts) => {
    const kept = entries.filter((e) => e.value !== null && e.value >= opts.threshold);
    // Never drop more than this share of a page: the gate may only trim.
    const floor = Math.ceil(entries.length * opts.maxDrop === 0 ? 1 : entries.length - Math.floor(entries.length * opts.maxDrop));
    return kept.length >= floor ? kept : entries.slice(0, floor);
  }
};

const args = parseArgs(process.argv.slice(2));
const splitKey = typeof args.split === "string" ? args.split : "s";
const splitPath = join(DATA_DIR, SPLITS[splitKey] ?? splitKey);
const limit = Number(args.limit ?? 60);
const seed = Number(args.seed ?? 5);
const topK = Number(args.topk ?? 20);
const concurrency = Number(args.concurrency ?? 4);
const variantNames = String(args.variants ?? Object.keys(VARIANTS).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
for (const name of variantNames) if (VARIANTS[name] === undefined) throw new Error(`unknown variant ${name}`);
const workdirRoot = resolve(String(args.workdir ?? join(tmpdir(), `gitmemo-gate-study-${process.pid}-${Date.now().toString(36)}`)));
// --replay <study.json> re-runs the analysis over recorded values: the decision
// axis is a pure function of them, so exploring it costs nothing.
const replayPath = typeof args.replay === "string" ? resolve(args.replay) : undefined;

const entries = loadSplit(splitPath);
const pool = [...entries];
let state = seed >>> 0 || 1;
const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const selected = pool.slice(0, limit);

console.log(`gate study · ${splitKey} · ${selected.length} instances · variants: ${variantNames.join(", ")}`);
console.log(`endpoint ${baseUrl} · model ${model}\n`);

const records = [];
let done = 0;
let replayed = false;
async function worker(cursor) {
  for (;;) {
    const index = cursor.next();
    if (index >= selected.length) return;
    const entry = selected[index];
    const corpus = buildCorpus(entry, "session");
    const stats = corpusStats(corpus.texts);
    const root = join(workdirRoot, entry.question_id.replace(/[^A-Za-z0-9_.-]/g, "_"));
    const memo = await createMemoRoot(root, { pageSize: topK, searchScoring: "weighted" });
    try {
      const items = corpus.slots.map((slot, i) => ({
        docId: slot.docId,
        text: slot.text,
        fallbackText: slot.fallbackText,
        content: renderContent({ sessionId: slot.sessionId, date: slot.date, turns: slot.turns, slot: i, granularity: "session" })
      }));
      const { hashToDocId } = await ingestInstance({ memo, items, ingestMode: "idf", stats, maxKeywords: 12 });
      const slotByDocId = new Map(corpus.slots.map((slot) => [slot.docId, slot]));

      // Page 1 only: exactly what one mem_search call hands to the gate.
      const { hashes } = await searchHashes(memo, queryKeywords(entry.question, stats, "plain", 15), { topK });
      const candidates = [];
      for (const hash of hashes) {
        const docId = hashToDocId.get(hash);
        if (docId === undefined) continue;
        const slot = slotByDocId.get(docId);
        candidates.push({
          hash,
          docId,
          gold: corpus.gold.has(docId) ? 1 : 0,
          // The entry body is the transcript; `slot.turns` is what the entry stores.
          body: slot.turns.map((t) => `${t.role}: ${t.content}`).join(" "),
          title: `[session] ${(slot.text || slot.fallbackText || "").slice(0, 80)}`,
          summary: (slot.text || slot.fallbackText || "").slice(0, 400),
          keywords: []
        });
      }
      if (candidates.length === 0) {
        records.push({ question_id: entry.question_id, question_type: entry.question_type, corpus_size: corpus.corpusIds.length, gold_count: corpus.gold.size, candidates: [], values: {} });
        return;
      }

      const values = {};
      const latencies = {};
      for (const name of variantNames) {
        const variant = VARIANTS[name];
        if (variant.chunked) {
          // Ask about each window, keep the best value per candidate. Several
          // candidates are judged in one request by packing one question per
          // (candidate, window) pair.
          const flat = [];
          for (let c = 0; c < candidates.length; c += 1) {
            const payloads = variant.payloads(candidates[c]);
            for (const payload of payloads) flat.push({ c, payload });
          }
          const { values: flatValues, latencyMs } = await judge(entry.question, flat.map((f) => f.payload), variant.question);
          const best = candidates.map(() => null);
          flat.forEach((f, i) => {
            const v = flatValues[i];
            if (v === null) return;
            if (best[f.c] === null || v > best[f.c]) best[f.c] = v;
          });
          values[name] = best;
          latencies[name] = latencyMs;
        } else {
          const { values: v, latencyMs } = await judge(entry.question, candidates.map((c) => variant.payloads(c)[0]), variant.question);
          values[name] = v;
          latencies[name] = latencyMs;
        }
      }
      records.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        corpus_size: corpus.corpusIds.length,
        gold_count: corpus.gold.size,
        candidates: candidates.map((c) => ({ hash: c.hash, docId: c.docId, gold: c.gold })),
        values,
        latencies
      });
    } finally {
      if (args["keep-workdir"] !== true) await removeMemoRoot(root);
    }
    done += 1;
    if (done % 10 === 0 || done === selected.length) console.log(`  ${done}/${selected.length} instances`);
  }
}

if (replayPath !== undefined) {
  const loaded = JSON.parse(await readFile(replayPath, "utf8"));
  records.push(...loaded.records);
  replayed = true;
  console.log(`replaying ${records.length} recorded instances from ${replayPath}\n`);
} else {
  await mkdir(workdirRoot, { recursive: true });
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker({ next: () => cursor++ })));
}

// ── analysis ────────────────────────────────────────────────────────────────

/** End-to-end metrics for one decision rule applied to every instance. */
function scoreDecision(variantName, decideFn) {
  const perInstance = [];
  for (const record of records) {
    if (record.candidates.length === 0) {
      perInstance.push({ question_id: record.question_id, question_type: record.question_type, gold_count: record.gold_count, metrics: null });
      continue;
    }
    const entriesForInstance = record.candidates
      .map((c, index) => ({ ...c, value: record.values[variantName]?.[index] ?? null }))
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.docId.localeCompare(b.docId));
    const kept = decideFn(entriesForInstance);
    // Ranked order: only what survived, in score order. Everything the rule
    // dropped is demoted below the page — that is what a hard filter does, and
    // modelling it as a mere reorder would make every filter look harmless.
    const ranked = kept.map((k) => k.docId);
    // The universe is exactly what survived. The plugin does NOT put a dropped
    // memory back: dropping gold means that gold is unreachable, which is what
    // made recall_all collapse in the pipeline. Leaving dropped candidates in
    // the universe (merely ordered last) would model the gate as harmless.
    const universe = ranked.length > 0 ? ranked : record.candidates.map((c) => c.docId);
    const gold = new Set(record.candidates.filter((c) => c.gold === 1).map((c) => c.docId));
    const metrics = computeMetrics(buildRankings(ranked, universe), gold, universe, "session");
    perInstance.push({ question_id: record.question_id, question_type: record.question_type, gold_count: record.gold_count, metrics });
  }
  const scored = perInstance.filter((r) => r.metrics !== null);
  const mean = (key) => scored.reduce((sum, r) => sum + (r.metrics.session[key] ?? 0), 0) / (scored.length || 1);
  return {
    n: scored.length,
    "recall_all@5": +mean("recall_all@5").toFixed(4),
    "recall_all@10": +mean("recall_all@10").toFixed(4),
    "ndcg_any@5": +mean("ndcg_any@5").toFixed(4),
    "ndcg_any@10": +mean("ndcg_any@10").toFixed(4),
    "recall_any@5": +mean("recall_any@5").toFixed(4)
  };
}

const analysis = {};
for (const name of variantNames) {
  const flatValues = [];
  const flatLabels = [];
  for (const record of records) {
    for (let i = 0; i < record.candidates.length; i += 1) {
      flatValues.push(record.values[name]?.[i] ?? null);
      flatLabels.push(record.candidates[i].gold);
    }
  }
  const goldValues = flatValues.filter((_, i) => flatLabels[i] === 1 && flatValues[i] !== null);
  const nonGoldValues = flatValues.filter((_, i) => flatLabels[i] === 0 && flatValues[i] !== null);
  const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const keptAt = (t) => goldValues.filter((v) => v >= t).length / (goldValues.length || 1);

  const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  const filterCurve = thresholds.map((t) => ({ threshold: t, metrics: scoreDecision(name, (es) => DECISIONS.filter(es, { threshold: t })) }));
  const bestFilter = filterCurve.reduce((best, row) => (row.metrics["recall_all@5"] > best.metrics["recall_all@5"] ? row : best), filterCurve[0]);

  analysis[name] = {
    label: VARIANTS[name].label,
    auc: auc(flatValues, flatLabels),
    meanValueGold: mean(goldValues),
    meanValueNonGold: mean(nonGoldValues),
    goldCandidates: goldValues.length,
    nonGoldCandidates: nonGoldValues.length,
    goldRetentionAt: Object.fromEntries(thresholds.map((t) => [t, +keptAt(t).toFixed(4)])),
    decisions: {
      rerank_all: scoreDecision(name, DECISIONS.rerank),
      shipped_filter_0_5: scoreDecision(name, (es) => DECISIONS.filter(es, { threshold: 0.5 })),
      best_filter: { threshold: bestFilter.threshold, ...bestFilter.metrics },
      keep_top5: scoreDecision(name, (es) => DECISIONS.keep_topN(es, { n: 5 })),
      keep_top10: scoreDecision(name, (es) => DECISIONS.keep_topN(es, { n: 10 })),
      tailcut_0_05: scoreDecision(name, (es) => DECISIONS.rerank_tailcut(es, { tail: 0.05 })),
      maxdrop_20pct: scoreDecision(name, (es) => DECISIONS.filter_then_cap(es, { threshold: 0.5, maxDrop: 0.2 }))
    }
  };
}

// no-gate reference on the same sample
const noGate = scoreDecision(variantNames[0], DECISIONS.rerank);

const report = {
  meta: {
    split: splitKey, seed, limit: selected.length, topk: topK,
    endpoint: baseUrl, model, generatedAt: new Date().toISOString(),
    note: "Recorded values are reused for every decision rule; only the REQUEST axes cost model calls."
  },
  noGate,
  analysis,
  records
};

const outDir = resolve(String(args.out ?? join(HERE, "results")));
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `gate-study-${splitKey}-seed${seed}-n${selected.length}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(outPath, JSON.stringify(report), "utf8");

console.log("\n── no gate (engine order) ──");
console.log(`  recall_all@5 ${noGate["recall_all@5"]}  recall_all@10 ${noGate["recall_all@10"]}  ndcg@5 ${noGate["ndcg_any@5"]}`);
for (const [name, a] of Object.entries(analysis)) {
  console.log(`\n── ${name}: ${a.label}`);
  console.log(`  AUC ${a.auc === null ? "n/a" : a.auc.toFixed(4)}  ·  mean value: gold ${a.meanValueGold?.toFixed(4)} vs non-gold ${a.meanValueNonGold?.toFixed(4)}  (${a.goldCandidates} gold / ${a.nonGoldCandidates} non-gold)`);
  console.log("  decision rules:");
  for (const [rule, m] of Object.entries(a.decisions)) {
    const threshold = m.threshold !== undefined ? ` (t=${m.threshold})` : "";
    console.log(`    ${rule.padEnd(20)} recall_all@5 ${String(m["recall_all@5"]).padStart(6)}  recall_all@10 ${String(m["recall_all@10"]).padStart(6)}  ndcg@5 ${String(m["ndcg_any@5"]).padStart(6)}${threshold}`);
  }
}
for (const name of variantNames) {
  const l = Object.values(records).flatMap((r) => (r.latencies?.[name] ? [r.latencies[name]] : []));
  if (l.length > 0) console.log(`  latency ${name}: avg ${Math.round(l.reduce((a, b) => a + b, 0) / l.length)}ms over ${l.length} requests`);
}
console.log(`\njson: ${outPath}`);
