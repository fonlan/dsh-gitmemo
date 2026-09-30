#!/usr/bin/env node
/**
 * gitmemo ↔ OmniMemEval bridge.
 *
 * OmniMemEval is Python; the gitmemo engine is Node. This process is the
 * transport between them: one JSON object per line on stdin, one JSON response
 * per line on stdout, no HTTP server and no port to manage.
 *
 *   → {"id":1,"cmd":"add","params":{"user_id":"...","session_id":"...","messages":[...]}}
 *   ← {"id":1,"ok":true,"result":{"hash":"...","keywords":[...]}}
 *
 * It is also where gitmemo's interface obligations are discharged: mem_write
 * needs 2–12 keywords and mem_search needs 1–15, while OmniMemEval hands over
 * whole sessions (add) and raw natural-language questions (search). Keyword
 * selection therefore lives here, and every strategy is selectable through the
 * GITMEMO_LME_* environment variables so a run is always attributable.
 *
 * One `.mem` repository per `user_id` (OmniMemEval uses one user per
 * conversation), so memories never leak across benchmark conversations, and
 * state lives on disk — a later pipeline step (a new Python process, a new
 * bridge) reattaches to the same repos instead of re-ingesting.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createMemoRoot, ENGINE_PATH, removeMemoRoot, searchHashes } from "../longmemeval/lib/ingest.mjs";
import { ChatClient } from "../longmemeval/lib/llm.mjs";
import { contentTokens, idfFromDf, ingestKeywords, queryKeywords, summarize, titleize } from "../longmemeval/lib/text.mjs";
import { formatMemory } from "../longmemeval/lib/format.mjs";

const env = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
};

const CONFIG = {
  baseDir: env("GITMEMO_LME_BASE_DIR", join(tmpdir(), "dsh-gitmemo-omni")),
  ingestKeywords: env("GITMEMO_LME_INGEST_KEYWORDS", "idf"), // idf | llm
  queryKeywords: env("GITMEMO_LME_QUERY_KEYWORDS", "plain"), // plain | idf | llm
  ingestText: env("GITMEMO_LME_INGEST_TEXT", "user"), // user | all
  summaryMode: env("GITMEMO_LME_SUMMARY", "extractive"), // extractive | prefix
  keywordScore: env("GITMEMO_LME_KEYWORD_SCORE", "bm25"), // bm25 | tfidf
  pageSize: Number(env("GITMEMO_LME_PAGE_SIZE", "20")),
  maxIngestKeywords: Number(env("GITMEMO_LME_MAX_INGEST_KEYWORDS", "12")),
  maxQueryKeywords: Number(env("GITMEMO_LME_MAX_QUERY_KEYWORDS", "15")),
  readTopK: env("GITMEMO_LME_READ_BODIES", "1") !== "0",
  llmModel: env("GITMEMO_LME_LLM_MODEL", env("DSH_LME_MODEL", "deepseek-chat")),
  llmBaseUrl: env("GITMEMO_LME_LLM_BASE_URL", env("DSH_LME_BASE_URL", "https://api.deepseek.com/v1")),
  /**
   * Optional System-one recall gate, the same two-stage recall the plugin's
   * mem_search tool performs (engine page -> gate -> survivors). Off by
   * default. The endpoint default points at a LOCAL typesafe-compatible
   * server, so nothing leaves the machine and there is no per-call cost.
   */
  gate: {
    enabled: env("GITMEMO_LME_GATE", "0") !== "0",
    endpoint: env("GITMEMO_LME_GATE_ENDPOINT", "http://127.0.0.1:8765/v1/systemone"),
    model: env("GITMEMO_LME_GATE_MODEL", "laya-multilingual"),
    mode: env("GITMEMO_LME_GATE_MODE", "noul"),
    threshold: Number(env("GITMEMO_LME_GATE_THRESHOLD", "0.5")),
    minKeep: Number(env("GITMEMO_LME_GATE_MIN_KEEP", "1")),
    maxCandidates: Number(env("GITMEMO_LME_GATE_MAX_CANDIDATES", "20")),
    maxTaskChars: Number(env("GITMEMO_LME_GATE_MAX_TASK_CHARS", "2000")),
    timeoutMs: Number(env("GITMEMO_LME_GATE_TIMEOUT", "60000")),
    apiKey: env("GITMEMO_LME_GATE_API_KEY", "local")
  }
};

const STATE_FILE = ".gitmemo-lme-state.json";
const users = new Map();
let client;

/**
 * The chat client must be built with `ChatClient.create` — the constructor takes
 * `apiKey` verbatim and does NOT resolve it, so `new ChatClient(...)` yields
 * `ready === false` and every LLM-written memory fails with "no API key
 * available". Resolution order: explicit option → DEEPSEEK_API_KEY /
 * OPENAI_API_KEY in the environment → the local DSH credential store.
 */
async function llm() {
  if (!client) {
    client = await ChatClient.create({
      baseUrl: CONFIG.llmBaseUrl,
      model: CONFIG.llmModel,
      apiKeyEnv: env("GITMEMO_LME_LLM_API_KEY_ENV", undefined),
      cacheDir: env("GITMEMO_LME_LLM_CACHE", join(CONFIG.baseDir, ".llm-cache")),
      concurrency: Number(env("GITMEMO_LME_LLM_CONCURRENCY", "4"))
    });
    if (!client.ready) {
      throw new Error(
        "bridge: LLM ingestion is configured but no API key could be resolved " +
          "(set DEEPSEEK_API_KEY / OPENAI_API_KEY, or store one in the DSH credential store)"
      );
    }
  }
  return client;
}

const safeName = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);

async function openUser(userId) {
  const root = join(CONFIG.baseDir, safeName(userId));
  await mkdir(root, { recursive: true });
  const memo = await createMemoRoot(root, { pageSize: CONFIG.pageSize });
  let df = new Map();
  let n = 0;
  try {
    const raw = JSON.parse(await readFile(join(root, STATE_FILE), "utf8"));
    df = new Map(Object.entries(raw.df ?? {}));
    n = Number(raw.n ?? 0);
  } catch {
    // first add for this user
  }
  return { root, memo, df, n, entries: [] };
}

async function getUser(userId) {
  const key = String(userId);
  if (!users.has(key)) users.set(key, await openUser(key));
  return users.get(key);
}

async function persist(user, userId) {
  const payload = JSON.stringify({ df: Object.fromEntries(user.df), n: user.n, entries: user.entries.slice(-2000) });
  await writeFile(join(user.root, STATE_FILE), payload, "utf8");
}

function statsOf(user) {
  return { df: user.df, idf: idfFromDf(user.df, user.n || 1), n: user.n || 1 };
}

/** Build the retrieval text: what the session is *about*, not the whole log. */
function retrievalText(messages) {
  const all = messages.map((m) => `${m.role}: ${m.content}`);
  if (CONFIG.ingestText === "all") return all.join("\n");
  const userTurns = messages.filter((m) => m.role === "user").map((m) => m.content);
  return (userTurns.length > 0 ? userTurns : all).join(" ");
}

function renderContent({ messages, sessionId, timestamp }) {
  const lines = [];
  if (timestamp) lines.push(`_Session date: ${timestamp}_`, "");
  for (const m of messages) lines.push(`**${m.role}:** ${m.content}`, "");
  lines.push(`<!-- lme session:${sessionId ?? "unknown"} -->`);
  return lines.join("\n");
}

async function describeSession({ messages, sessionId, stats }) {
  const text = retrievalText(messages);
  if (CONFIG.ingestKeywords === "llm") {
    const prompt =
      "You are a coding agent writing ONE long-term memory entry for a past conversation session.\n" +
      "Reply with STRICT JSON only:\n" +
      '{"title": "<single line, <= 120 chars>", "summary": "<1-3 sentences>", ' +
      '"keywords": ["2-12 short lowercase topical keywords"]}\n' +
      "Keywords are used later as FIXED-STRING OR greps by a future search, so prefer short, distinctive, " +
      "literal terms (names, places, objects, activities) over whole sentences or generic words.\n\n" +
      "Session (id " + String(sessionId) + "):\n" + text.slice(0, 12000);
    const chat = await llm();
    const raw = await chat.chatJson([{ role: "user", content: prompt }], { maxTokens: 300 });
    const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k) => String(k).trim().toLowerCase())
      .filter((k) => k.length > 0 && k.length <= 64)
      .slice(0, CONFIG.maxIngestKeywords);
    const fallbackKeywords = ingestKeywords(text, stats, CONFIG.maxIngestKeywords, { score: CONFIG.keywordScore });
    const { extractiveSummary: summarizeExtractive } = await import("../longmemeval/lib/text.mjs");
    const fallbackSummary = summarizeExtractive(text, stats).trim() || "(empty session)";
    return {
      title: String(raw.title ?? titleize(text)).replace(/[\r\n]+/g, " ").slice(0, 200) || titleize(text),
      summary: String(raw.summary ?? fallbackSummary).replace(/\s+/g, " ").slice(0, 1000) || fallbackSummary,
      keywords: keywords.length >= 2 ? keywords : fallbackKeywords
    };
  }
  const { titleize, summarize, extractiveSummary, ingestKeywords: extract } = await import("../longmemeval/lib/text.mjs");
  const summaryText = (CONFIG.summaryMode === "prefix" ? summarize(text) : extractiveSummary(text, stats)).trim();
  return {
    title: titleize(text),
    // mem_write rejects an empty summary; a session can legitimately be empty
    // once its blank turns are dropped.
    summary: summaryText.length > 0 ? summaryText : "(empty session)",
    keywords: extract(text, stats, CONFIG.maxIngestKeywords, { score: CONFIG.keywordScore })
  };
}

async function queryKeywordsFor(query, user) {
  if (CONFIG.queryKeywords === "llm") {
    const prompt =
      "Extract 1-15 keyword search terms from the question below, for searching a personal chat memory index.\n" +
      "They are used as FIXED-STRING OR greps against past memory titles, summaries and keyword lists, so they must be " +
      "short literal topical terms or names a memory entry would plausibly contain verbatim — not sentences, not stopwords.\n" +
      'Reply with STRICT JSON only: {"keywords": ["..."]}\n\nQuestion: ' + query;
    const chat = await llm();
    const raw = await chat.chatJson([{ role: "user", content: prompt }], { maxTokens: 200 });
    const kws = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k) => String(k).trim().toLowerCase())
      .filter((k) => k.length > 0 && k.length <= 64)
      .slice(0, CONFIG.maxQueryKeywords);
    if (kws.length > 0) return kws;
  }
  const mode = CONFIG.queryKeywords === "idf" ? "idf" : "plain";
  return queryKeywords(query, user ? statsOf(user) : undefined, mode, CONFIG.maxQueryKeywords).slice(0, CONFIG.maxQueryKeywords);
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdAdd({ user_id, session_id, messages, timestamp }) {
  if (!Array.isArray(messages) || messages.length === 0) return { skipped: true, reason: "empty session" };
  const user = await getUser(user_id);
  const clean = messages
    .map((m) => ({ role: String(m.role ?? "user"), content: String(m.content ?? "") }))
    .filter((m) => m.content.trim().length > 0);
  if (clean.length === 0) return { skipped: true, reason: "empty session after cleaning" };

  const fields = await describeSession({ messages: clean, sessionId: session_id, stats: statsOf(user) });
  // The engine rejects control bytes in title / summary / content, and scraped
  // chat transcripts carry them; cleaning is the adapter's job.
  const { sanitizeForEngine } = await import("../longmemeval/lib/text.mjs");
  const content = sanitizeForEngine(renderContent({ messages: clean, sessionId: session_id, timestamp }));
  const metadata = {
    title: sanitizeForEngine(fields.title),
    summary: sanitizeForEngine(fields.summary),
    keywords: fields.keywords
  };
  let result;
  try {
    result = await user.memo.write({ ...metadata, content });
  } catch (error) {
    if (!String(error?.message ?? "").includes("same digest")) throw error;
    result = await user.memo.write({ ...metadata, content: `${content}\n<!-- retry:${user.n} -->` });
  }
  // Online IDF: update document frequencies *after* choosing this session's
  // keywords, so a session can never tune its own terms with hindsight.
  for (const term of new Set(contentTokens(retrievalText(clean)))) {
    user.df.set(term, (user.df.get(term) ?? 0) + 1);
  }
  user.n += 1;
  user.entries.push({ session_id, hash: result.hash, title: fields.title, summary: fields.summary, keywords: fields.keywords });
  await persist(user, user_id);
  return { hash: result.hash, file: result.file, keywords: fields.keywords, title: fields.title, sessions: user.n };
}

async function cmdSearch({ user_id, query, top_k }) {
  const user = await getUser(user_id);
  const question = String(query ?? "");
  const keywords = await queryKeywordsFor(question, user);
  const limit = Number(top_k ?? 20);
  const gateOpts = CONFIG.gate.enabled
    ? {
        endpoint: CONFIG.gate.endpoint,
        model: CONFIG.gate.model,
        mode: CONFIG.gate.mode,
        threshold: CONFIG.gate.threshold,
        scoreMin: 2,
        minKeep: CONFIG.gate.minKeep,
        maxCandidates: CONFIG.gate.maxCandidates,
        maxTaskChars: CONFIG.gate.maxTaskChars,
        timeoutMs: CONFIG.gate.timeoutMs,
        apiKey: CONFIG.gate.apiKey,
        onDecision: (decision) => {
          if (decision.degraded) {
            process.stderr.write(`bridge: gate DEGRADED for ${user_id}: ${decision.reason ?? "unknown"}\n`);
          }
        }
      }
    : undefined;
  const { hashes, total, calls, gateCalls, gateDropped } = await searchHashes(user.memo, keywords, {
    topK: limit,
    task: question,
    gate: gateOpts
  });
  const memories = [];
  for (const hash of hashes) {
    const known = user.entries.find((e) => e.hash === hash);
    const entry = { hash, title: known?.title ?? "", summary: known?.summary ?? "", content: "" };
    if (CONFIG.readTopK) {
      try {
        const read = await user.memo.read(hash);
        entry.content = formatMemory(read.content, { title: known?.title, summary: known?.summary });
      } catch (error) {
        // Fall back to the commit-message projections if the body is unreadable.
        entry.content = [known?.title, known?.summary].filter(Boolean).join("\n\n");
        entry.error = String(error?.message ?? error);
      }
    }
    if (entry.content.length > 0 || entry.title.length > 0) memories.push(entry);
  }
  return {
    keywords,
    total,
    search_calls: calls,
    ...(gateOpts ? { gate_calls: gateCalls, gate_dropped: gateDropped } : {}),
    memories
  };
}

async function cmdDelete({ user_id }) {
  const key = String(user_id);
  const user = users.get(key);
  const root = user?.root ?? join(CONFIG.baseDir, safeName(key));
  users.delete(key);
  await removeMemoRoot(root);
  return { deleted: true, root };
}

async function cmdStats({ user_id }) {
  const user = users.get(String(user_id));
  if (!user) return { open: false };
  return { open: true, sessions: user.n, terms: user.df.size, root: user.root };
}

async function cmdClose() {
  return { closed: true };
}

const COMMANDS = {
  ping: async () => {
    // Only resolve the credential when a mode actually needs the LLM, so the
    // deterministic modes still start with no key present.
    const needsLlm = CONFIG.ingestKeywords === "llm" || CONFIG.queryKeywords === "llm";
    const chat = needsLlm ? await llm() : undefined;
    return {
      engine: ENGINE_PATH,
      config: CONFIG,
      llmNeeded: needsLlm,
      llmReady: chat ? chat.ready : false,
      node: process.version
    };
  },
  add: cmdAdd,
  search: cmdSearch,
  delete: cmdDelete,
  stats: cmdStats,
  close: cmdClose
};

// ── transport ───────────────────────────────────────────────────────────────

async function dispatch(request) {
  const handler = COMMANDS[request?.cmd];
  if (!handler) throw new Error(`bridge: unknown command ${JSON.stringify(request?.cmd)}`);
  return handler(request.params ?? {});
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let queue = Promise.resolve();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: null, ok: false, error: `bridge: invalid JSON: ${error.message}` }) + "\n");
      return;
    }
    try {
      const result = await dispatch(request);
      process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: true, result }) + "\n");
      if (request.cmd === "close") {
        rl.close();
        process.exit(0);
      }
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ id: request.id ?? null, ok: false, error: String(error?.message ?? error) }) + "\n"
      );
    }
  });
});

rl.on("close", () => {
  queue.finally(() => process.exit(0));
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`bridge: uncaught ${error?.stack ?? error}\n`);
});
