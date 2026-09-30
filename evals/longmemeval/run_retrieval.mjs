#!/usr/bin/env node
/**
 * LongMemEval retrieval evaluation against the real gitmemo engine.
 *
 * For every instance: ingest the instance's haystack into a fresh `.mem`
 * repository (one entry per session, or one per user turn), run the simulated
 * `mem_search` call, and score the ranking with LongMemEval's official
 * retrieval metrics. Two reference retrievers are computed on the identical
 * corpus text so the result is interpretable:
 *
 *   gitmemo — keyword-grep recall over commit-message projections (the system
 *             under test; the keywords ARE the retrieval surface)
 *   bm25    — the paper's flat-bm25 analog over full session text, same corpus
 *   oracle  — gold-first ranking, the official ceiling
 *
 * Usage:
 *   node run_retrieval.mjs --split oracle --limit 20
 *   node run_retrieval.mjs --split s --granularity session --concurrency 8
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus, buildRankings, loadSplit, splitStats } from "./lib/dataset.mjs";
import { aggregate, computeMetrics } from "./lib/metrics.mjs";
import { corpusStats, bm25Rank, queryKeywords } from "./lib/text.mjs";
import { createMemoRoot, GitMemo, ingestInstance, removeMemoRoot, renderContent, searchHashes, ENGINE_PATH } from "./lib/ingest.mjs";
import { ChatClient } from "./lib/llm.mjs";
import { goldOnlyMeans, printConsoleSummary, renderMarkdownReport } from "./lib/report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");
const SPLITS = {
  oracle: "longmemeval_oracle.json",
  s: "longmemeval_s_cleaned.json",
  m: "longmemeval_m_cleaned.json"
};

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

function safeName(id) {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

const args = parseArgs(process.argv.slice(2));
const splitKey = typeof args.split === "string" ? args.split : "oracle";
const splitPath = args.data ? resolve(String(args.data)) : join(DATA_DIR, SPLITS[splitKey] ?? splitKey);
const granularity = String(args.granularity ?? "session");
if (!["session", "turn"].includes(granularity)) throw new Error(`--granularity must be session|turn`);
const scoringMode = String(args.scoring ?? "weighted");
if (!["count", "weighted"].includes(scoringMode)) throw new Error("--scoring must be count|weighted");
const retrievers = String(args.retrievers ?? "gitmemo,bm25,oracle").split(",").map((s) => s.trim()).filter(Boolean);
const gitmemoSpecs = retrievers.map(parseGitmemoSpec).filter((spec) => spec !== undefined);
if (retrievers.some((r) => r.startsWith("gitmemo")) && gitmemoSpecs.length === 0) {
  throw new Error(`unrecognised gitmemo retriever name(s): ${retrievers.filter((r) => r.startsWith("gitmemo")).join(", ")}`);
}
const queryKeywordMode = String(args["query-keywords"] ?? "plain");
const ingestKeywordMode = String(args["ingest-keywords"] ?? "idf");
const topK = Number(args.topk ?? 50);
const pageSize = Number(args["page-size"] ?? 20);
const concurrency = Number(args.concurrency ?? 8);
const maxKeywords = Number(args["max-keywords"] ?? 12);
/**
 * gitmemo retrievers accept a configuration suffix, so one ingest pass can
 * answer the whole 2x2: `gitmemo`, `gitmemo-count`, `gitmemo-gate`,
 * `gitmemo-count-gate`. `gitmemo` alone keeps the engine's own default.
 */
function parseGitmemoSpec(name) {
  // gitmemo[-count][-gate[-tNN][-k0]]
  //   -tNN  gate threshold, NN percent (t35 -> 0.35)
  //   -k0   gate minKeep 0: measure the gate withOUT the plugin's floor, which
  //         is what actually reveals how much the floor protects (a wholly
  //         rejected page keeps one candidate under the plugin default).
  const m = /^gitmemo(?:-(count|weighted))?(?:-gate(?:-t(\d{1,2}))?(?:-k(\d+))?)?$/.exec(name);
  if (m === null) return undefined;
  const explicitMode = m[1];
  return {
    name,
    count: explicitMode === "count" || (explicitMode === undefined && scoringMode === "count"),
    gate: /-gate/.test(name),
    gateThreshold: m[2] !== undefined ? Number(m[2]) / 100 : undefined,
    gateMinKeep: m[3] !== undefined ? Number(m[3]) : undefined
  };
}

/**
 * System-one gate options. Defaults point at a LOCAL typesafe-compatible
 * server, so nothing leaves the machine and there is no per-call cost.
 */
const gateOptions = {
  endpoint: String(args["gate-endpoint"] ?? process.env.GITMEMO_GATE_ENDPOINT ?? "http://127.0.0.1:8765/v1/systemone"),
  model: String(args["gate-model"] ?? process.env.GITMEMO_GATE_MODEL ?? "laya-multilingual"),
  mode: String(args["gate-mode"] ?? "noul"),
  threshold: Number(args["gate-threshold"] ?? 0.5),
  scoreMin: Number(args["gate-score-min"] ?? 2),
  // The plugin's own default: a wholly-rejected page still keeps one candidate.
  // Pass --gate-min-keep 0 to measure the gate without that floor.
  minKeep: Number(args["gate-min-keep"] ?? 1),
  maxCandidates: Number(args["gate-max-candidates"] ?? 20),
  maxTaskChars: Number(args["gate-max-task-chars"] ?? 2000),
  timeoutMs: Number(args["gate-timeout"] ?? 60000),
  apiKey: String(args["gate-api-key"] ?? process.env.GITMEMO_GATE_API_KEY ?? "local")
};

const summaryMode = String(args.summary ?? "extractive");
const keywordScore = String(args["keyword-score"] ?? "bm25");
if (!["extractive", "prefix"].includes(summaryMode)) throw new Error("--summary must be extractive|prefix");
if (!["bm25", "tfidf"].includes(keywordScore)) throw new Error("--keyword-score must be bm25|tfidf");
const limit = args.limit !== undefined ? Number(args.limit) : undefined;
const offset = Number(args.offset ?? 0);
const seed = args.seed !== undefined ? Number(args.seed) : undefined;
const keepWorkdir = args["keep-workdir"] === true;
const quiet = args.quiet === true;
const failFast = args["fail-fast"] === true;
// A unique root per run: two concurrent runs share question ids, so a fixed
// path would let one run's cleanup delete the other's in-flight `.mem` repos.
const runId = `${process.pid}-${Date.now().toString(36)}`;
const workdirRoot = resolve(
  String(args.workdir ?? join(tmpdir(), `dsh-gitmemo-lme-${safeName(splitKey)}-${runId}`))
);
const outDir = resolve(String(args.out ?? join(HERE, "results")));
const logEvery = Number(args["log-every"] ?? 10);

const startedAt = Date.now();
const log = (...rest) => {
  if (!quiet) console.log(...rest);
};

// ---------------------------------------------------------------- load input
const entries = loadSplit(splitPath);
let selected = entries;
if (seed !== undefined) {
  // Deterministic reservoir-free sampling: shuffle a copy with a seeded PRNG.
  const pool = [...entries];
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  selected = pool;
}
if (offset > 0 || limit !== undefined) selected = selected.slice(offset, limit !== undefined ? offset + limit : undefined);

const stats = splitStats(selected);
log(`gitmemo engine: ${ENGINE_PATH}`);
log(`split: ${splitKey} (${splitPath})`);
log(
  `instances: ${selected.length} · granularity: ${granularity} · retrievers: ${retrievers.join(",")} · ` +
    `query keywords: ${queryKeywordMode} · ingest keywords: ${ingestKeywordMode} · concurrency: ${concurrency}`
);
log(
  `corpus: ${stats.sessions_total} sessions (min·median·max ${stats.sessions_min}·${stats.sessions_median}·${stats.sessions_max}), ` +
    `${stats.user_turns} user turns, ${stats.answer_turns} answer turns, ${stats.abstention} abstention instances`
);

// ------------------------------------------------------------- llm (optional)
const needsClient = queryKeywordMode === "llm" || ingestKeywordMode === "llm" || retrievers.includes("llm");
const client = needsClient
  ? await ChatClient.create({
      baseUrl: args["base-url"],
      model: args.model,
      apiKeyEnv: args["api-key-env"],
      cacheDir: join(HERE, ".cache"),
      concurrency: Number(args["llm-concurrency"] ?? concurrency)
    })
  : undefined;
if (needsClient && !client.ready) throw new Error("run: LLM modes need an API key (DEEPSEEK_API_KEY / --api-key-env)");

async function queryFor(question, corpusStatsForInstance) {
  if (queryKeywordMode === "llm") {
    const prompt =
      "Extract 1-15 short keyword search terms from the question below, for searching a personal chat memory index.\n" +
      "They will be used as FIXED-STRING OR greps against past memory titles, summaries and keyword lists, so they must be " +
      "short topical terms or names that a memory entry would plausibly contain verbatim — not whole sentences, not stopwords.\n" +
      'Reply with STRICT JSON only: {"keywords": ["...", "..."]}\n\nQuestion: ' +
      question;
    const raw = await client.chatJson([{ role: "user", content: prompt }], { maxTokens: 200 });
    const kws = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k) => String(k).trim().toLowerCase())
      .filter((k) => k.length > 0 && k.length <= 64)
      .slice(0, 15);
    if (kws.length > 0) return kws;
  }
  return queryKeywords(question, corpusStatsForInstance, queryKeywordMode === "idf" ? "idf" : "plain", 15);
}

// ------------------------------------------------------------------ one item
async function processInstance(entry) {
  const corpus = buildCorpus(entry, granularity);
  const instanceStats = corpusStats(corpus.texts);
  const ranked = {};
  const diagnostics = { corpus_size: corpus.corpusIds.length, gold_count: corpus.gold.size };
  const t0 = Date.now();

  if (gitmemoSpecs.length > 0) {
    const root = join(workdirRoot, safeName(entry.question_id));
    const memo = await createMemoRoot(root, { pageSize, searchScoring: "weighted" });
    try {
      const items = corpus.slots.map((slot, index) => ({
        docId: slot.docId,
        text: slot.text,
        fallbackText: slot.fallbackText,
        content: renderContent({
          sessionId: slot.sessionId,
          date: slot.date,
          turns: slot.turns,
          slot: index,
          granularity
        })
      }));
      const { hashToDocId } = await ingestInstance({
        memo,
        items,
        ingestMode: ingestKeywordMode,
        stats: instanceStats,
        client,
        maxKeywords,
        summaryMode,
        keywordScore
      });
      // One ingestion, one query-keyword set, N retrieval configurations: the
      // 2x2 of scoring mode x System-one gate costs a single ingest pass.
      const keywords = await queryFor(entry.question, instanceStats);
      diagnostics.query_keywords = keywords;
      diagnostics.gitmemo_entries = items.length;
      const goldDocIds = corpus.gold;
      for (const spec of gitmemoSpecs) {
        const scoring = spec.count ? "count" : "weighted";
        const handle = scoring === "weighted"
          ? memo
          : new GitMemo(root, { searchLimit: pageSize, searchScoring: "count", gitTimeoutMs: 120000 });
        let droppedGold = 0;
        const gate = spec.gate
          ? {
              ...gateOptions,
              ...(spec.gateThreshold !== undefined ? { threshold: spec.gateThreshold } : {}),
              ...(spec.gateMinKeep !== undefined ? { minKeep: spec.gateMinKeep } : {}),
              onDecision: (decision, page) => {
                for (const verdict of decision.verdicts) {
                  if (verdict.keep) continue;
                  const docId = hashToDocId.get(verdict.hash);
                  if (docId !== undefined && goldDocIds.has(docId)) droppedGold += 1;
                }
                void page;
              }
            }
          : undefined;
        const { hashes, total, calls, gateCalls, gateDropped } = await searchHashes(handle, keywords, {
          topK,
          task: entry.question,
          gate
        });
        const docIds = hashes.map((h) => hashToDocId.get(h)).filter(Boolean);
        ranked[spec.name] = docIds;
        diagnostics[`${spec.name}__total_hits`] = total;
        diagnostics[`${spec.name}__search_calls`] = calls;
        if (spec.gate) {
          diagnostics[`${spec.name}__gate_calls`] = gateCalls;
          diagnostics[`${spec.name}__gate_dropped`] = gateDropped;
          diagnostics[`${spec.name}__gate_dropped_gold`] = droppedGold;
        }
      }
    } finally {
      if (!keepWorkdir) await removeMemoRoot(root);
    }
  }

  if (retrievers.includes("bm25")) {
    ranked.bm25 = bm25Rank(entry.question, corpus.texts).map((idx) => corpus.corpusIds[idx]);
  }

  if (retrievers.includes("oracle")) {
    ranked.oracle = [
      ...corpus.corpusIds.filter((id) => corpus.gold.has(id)),
      ...corpus.corpusIds.filter((id) => !corpus.gold.has(id))
    ];
  }

  const metrics = {};
  for (const [retriever, list] of Object.entries(ranked)) {
    metrics[retriever] = computeMetrics(buildRankings(list, corpus.corpusIds), corpus.gold, corpus.corpusIds, granularity);
  }

  return {
    question_id: entry.question_id,
    question_type: entry.question_type,
    question: entry.question,
    gold_count: corpus.gold.size,
    ...diagnostics,
    elapsed_ms: Date.now() - t0,
    metrics,
    ranked: Object.fromEntries(Object.entries(ranked).map(([k, v]) => [k, v.slice(0, topK)]))
  };
}

// ---------------------------------------------------------------- run a pool
const records = [];
let done = 0;
let failed = 0;
const failMessages = [];
/**
 * A handful of instances can hit a transient filesystem error while many
 * parallel `git` processes churn the temp volume ("unable to create temporary
 * file", ENOTEMPTY). Those are environment flakes, not engine failures, so an
 * instance gets a bounded number of fresh-repo attempts; anything that still
 * fails is reported rather than hidden.
 */
async function processInstanceWithRetry(entry, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await processInstance(entry);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const transient = /unable to create temporary file|unable to index file|ENOTEMPTY|EBUSY|ENOENT|EAGAIN/i.test(message);
      if (!transient || attempt === attempts) break;
      log(`  ↻ ${entry.question_id}: transient (${message.split("\n")[0].slice(0, 90)}); retry ${attempt + 1}/${attempts}`);
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

async function workerLoop(cursor) {
  for (;;) {
    const index = cursor.next();
    if (index >= selected.length) return;
    const entry = selected[index];
    try {
      records.push(await processInstanceWithRetry(entry));
    } catch (error) {
      failed += 1;
      const message = `${entry.question_id}: ${error?.message ?? error}`;
      failMessages.push(message);
      console.error(`[fail] ${message}`);
      if (failFast) throw error;
    } finally {
      done += 1;
      if (done % logEvery === 0 || done === selected.length) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done / elapsed;
        const eta = rate > 0 ? (selected.length - done) / rate : 0;
        log(
          `  ${done}/${selected.length} instances · ${elapsed.toFixed(0)}s elapsed · ${rate.toFixed(2)} inst/s · ETA ${eta.toFixed(0)}s` +
            (failed ? ` · ${failed} failed` : "")
        );
      }
    }
  }
}

await mkdir(workdirRoot, { recursive: true });
log("running…");
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(concurrency, selected.length)) }, () =>
    workerLoop({
      next: () => {
        const current = cursor;
        cursor += 1;
        return current;
      }
    })
  )
);

// ------------------------------------------------------------------- report
records.sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0));
const elapsedMs = Date.now() - startedAt;
const perRetriever = {};
for (const retriever of retrievers) {
  // Retriever-scoped rows: `metrics` becomes the granularity-keyed block for
  // this one retriever, which is the shape aggregate()/goldOnlyMeans() expect.
  const rows = records.map((r) => ({ ...r, metrics: r.metrics[retriever] }));
  const summary = aggregate(rows);
  const goldOnly = {
    session: goldOnlyMeans(rows, "session"),
    turn: goldOnlyMeans(rows, "turn")
  };
  perRetriever[retriever] = { ...summary, gold_only: goldOnly };
}

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const baseName = `${splitKey}-${granularity}-q${queryKeywordMode}-i${ingestKeywordMode}-n${selected.length}-${stamp}`;
const jsonPath = join(outDir, `${baseName}.json`);
const mdPath = join(outDir, `${baseName}.md`);

const run = {
  meta: {
    split: splitKey,
    splitPath,
    granularity,
    retrievers,
    queryKeywords: queryKeywordMode,
    ingestKeywords: ingestKeywordMode,
    summaryMode,
    keywordScore,
    searchScoring: scoringMode,
    gate: gitmemoSpecs.some((spec) => spec.gate)
      ? {
          endpoint: gateOptions.endpoint,
          model: gateOptions.model,
          mode: gateOptions.mode,
          threshold: gateOptions.threshold,
          minKeep: gateOptions.minKeep,
          maxCandidates: gateOptions.maxCandidates
        }
      : null,
    topK,
    pageSize,
    concurrency,
    maxKeywords,
    nInstances: selected.length,
    offset,
    limit: limit ?? null,
    seed: seed ?? null,
    elapsedMs,
    failed,
    generatedAt: new Date().toISOString(),
    engine: ENGINE_PATH,
    notes: [
      "Metrics are LongMemEval's official retrieval metrics (port of src/retrieval/eval_utils.py); `_abs` instances are excluded from the means.",
      "Gold = corpus ids containing `answer` AND holding a `has_answer: true` user turn — the official rule, not the `answer_session_ids` field.",
      "gitmemo's retrieval surface is the commit-message projections only (title / summary / keywords); entry bodies are never scanned.",
      "Ingest keywords are chosen with instance-corpus IDF, which an online agent could only approximate with history-so-far statistics."
    ]
  },
  splitStats: stats,
  summary: {
    perRetriever,
    gold_free_non_abstention: records.filter((r) => !r.question_id.includes("_abs") && r.gold_count === 0).length
  },
  failMessages,
  llmUsage: client ? { ...client.usage, model: client.model, baseUrl: client.baseUrl } : undefined,
  records
};

await writeFile(jsonPath, JSON.stringify(run), "utf8");
await writeFile(mdPath, renderMarkdownReport({ ...run, summary: { ...run.summary, perRetriever: perRetriever }, perRetrieverElapsed: undefined }), "utf8");

log("");
console.log(`done in ${(elapsedMs / 1000).toFixed(1)}s · ${records.length} instances scored${failed ? ` · ${failed} failed` : ""}`);
printConsoleSummary({ summary: { perRetriever } });
for (const [retriever, block] of Object.entries(perRetriever)) {
  console.log(`  ${retriever} gold-only means (session):`, JSON.stringify(block.gold_only.session));
}
if (client) console.log("  llm usage:", JSON.stringify({ ...client.usage, model: client.model }));
console.log(`  json: ${jsonPath}`);
console.log(`  md:   ${mdPath}`);
