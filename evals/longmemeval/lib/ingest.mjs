/**
 * The gitmemo adapter: LongMemEval ingestion and retrieval through the real
 * `GitMemo` engine (`lib/mem.js`), not a re-implementation of it.
 *
 * Ingestion contract (what a real agent session would do):
 *   one haystack session (or one user turn, at turn granularity) → one
 *   immutable `.mem` entry (one commit), with `title` / `summary` / `keywords`
 *   chosen by the configured strategy.
 *
 * The isolation, the entry-per-item granularity and the "keywords are the whole
 * retrieval surface" property are exactly what the engine imposes:
 * `GitMemo.search` greps ONLY the commit-message projections (title, summary,
 * keywords) — entry bodies are never scanned.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// Import the built engine (same artifact the plugin ships). The harness is
// deliberately not part of the plugin build.
const ENGINE = new URL("../../../lib/mem.js", import.meta.url).href;
const { GitMemo } = await import(ENGINE);

export { GitMemo };

export const ENGINE_PATH = ENGINE;

/** Create a throwaway project root with an initialized `.mem` repository. */
export async function createMemoRoot(root, { pageSize = 20, gitTimeoutMs = 120000 } = {}) {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const memo = new GitMemo(root, { searchLimit: pageSize, gitTimeoutMs, lockTimeoutMs: 60000 });
  await memo.init();
  return memo;
}

export async function removeMemoRoot(root) {
  // A concurrent reader can briefly recreate the lock file inside the tree, so
  // a single `rm -rf` occasionally loses the race with ENOTEMPTY. Retry.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Render a haystack session as the markdown body of a memory entry. */
export function renderContent({ sessionId, date, turns, slot, granularity }) {
  const lines = [];
  if (date) lines.push(`_Session date: ${date}_`, "");
  if (granularity === "turn") {
    lines.push(turns.map((t) => t.content).join("\n\n"));
  } else {
    for (const turn of turns) {
      lines.push(`**${turn.role}:** ${turn.content}`, "");
    }
  }
  // A unique marker keeps the engine's duplicate-digest guard from rejecting
  // byte-identical sessions inside one instance. Bodies are never searched.
  lines.push(`<!-- lme slot:${slot} session:${sessionId} -->`);
  return lines.join("\n");
}

/**
 * Choose `title` / `summary` / `keywords` for one corpus item.
 *  - `idf`  : deterministic heuristic over the item text (default, no API key)
 *  - `llm`  : one chat call per item, mirroring an agent writing the memory
 */
export async function describeItem(item, { ingestMode, stats, client, maxKeywords = 12, summaryMode = "extractive", keywordScore = "bm25" }) {
  // A filler session can hold assistant turns only, leaving the user-only
  // retrieval text empty; mem_write rejects an empty summary, so fall back to
  // the full transcript for the metadata (the official corpus item itself is
  // left untouched).
  const text = item.text && item.text.trim().length > 0 ? item.text : (item.fallbackText ?? "");
  item = { ...item, text };
  // Imported once up front: the LLM branch below also needs sanitizeForEngine,
  // and a `const` declared in the later branch would be in its temporal dead
  // zone there.
  const { titleize, summarize, extractiveSummary, ingestKeywords: extract, sanitizeForEngine } = await import("./text.mjs");
  if (ingestMode === "llm") {
    if (!client?.ready) throw new Error("ingest: --ingest-keywords llm requires an API key");
    const fallbackSummary = (summaryMode === "prefix" ? summarize(text) : extractiveSummary(text, stats)).trim() || "(empty session)";
    const prompt =
      "You are a coding agent recording a long-term memory entry for a past interaction.\n" +
      "Read the interaction and reply with STRICT JSON only:\n" +
      '{"title": "<single line, <= 120 chars>", "summary": "<1-3 sentences>", ' +
      '"keywords": ["2-12 short topical keywords, lowercase, no duplicates"]}\n' +
      "Keywords must be terms a future search would plausibly grep for verbatim; " +
      "record concrete specifics (names, objects, activities, decisions), not just the topic.\n\n" +
      "Interaction:\n" +
      text.slice(0, 6000);
    const raw = await client.chatJson([{ role: "user", content: prompt }], { maxTokens: 300 });
    const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k) => String(k).trim().toLowerCase())
      .filter((k) => k.length > 0 && k.length <= 64)
      .slice(0, maxKeywords);
    return {
      title: sanitizeForEngine(String(raw.title ?? titleize(text)).replace(/[\r\n]+/g, " ")).slice(0, 200) || sanitizeForEngine(titleize(text)),
      summary: sanitizeForEngine(String(raw.summary ?? fallbackSummary).replace(/\s+/g, " ")).slice(0, 1000) || fallbackSummary,
      keywords: keywords.length >= 2 ? keywords : extract(text, stats, maxKeywords, { score: keywordScore })
    };
  }
  const summaryText = (summaryMode === "prefix" ? summarize(text) : extractiveSummary(text, stats)).trim();
  return {
    title: sanitizeForEngine(titleize(text)),
    // mem_write rejects an empty summary; a session can legitimately be empty.
    summary: sanitizeForEngine(summaryText.length > 0 ? summaryText : "(empty session)"),
    keywords: extract(text, stats, maxKeywords, { score: keywordScore })
  };
}

/**
 * Write one entry per corpus item. Returns the doc-id ↔ commit-hash mapping
 * used to translate search hits back into the official index space.
 */
export async function ingestInstance({ memo, items, ingestMode, stats, client, maxKeywords = 12, summaryMode = "extractive", keywordScore = "bm25", onProgress }) {
  const docIdToHash = new Map();
  const hashToDocId = new Map();
  const { sanitizeForEngine } = await import("./text.mjs");
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const fields = await describeItem(item, { ingestMode, stats, client, maxKeywords, summaryMode, keywordScore });
    // The engine rejects control bytes in content too, and LongMemEval's
    // scraped transcripts do contain them.
    const content = sanitizeForEngine(item.content);
    let result;
    try {
      result = await memo.write({
        title: fields.title,
        summary: fields.summary,
        keywords: fields.keywords,
        content
      });
    } catch (error) {
      // Last-resort collision guard: the slot marker should already prevent
      // this, but never let one bad item abort a whole instance.
      if (!String(error?.message ?? "").includes("same digest")) throw error;
      result = await memo.write({
        title: fields.title,
        summary: fields.summary,
        keywords: fields.keywords,
        content: `${content}\n<!-- retry:${i} -->`
      });
    }
    docIdToHash.set(item.docId, result.hash);
    hashToDocId.set(result.hash, item.docId);
    onProgress?.(i + 1, items.length);
  }
  return { docIdToHash, hashToDocId };
}

/**
 * The simulated `mem_search` call: 1–15 keywords, paged with the returned
 * snapshot exactly like the agent tool does, until `topK` hits or exhaustion.
 */
export async function searchHashes(memo, keywords, { topK = 50 } = {}) {
  const hashes = [];
  let skip = 0;
  let snapshot;
  let total = Number.POSITIVE_INFINITY;
  let calls = 0;
  while (hashes.length < topK && skip < total) {
    const page = await memo.search(keywords, { skip, ...(snapshot ? { snapshot } : {}) });
    calls += 1;
    snapshot = page.snapshot;
    total = page.total;
    if (page.results.length === 0) break;
    for (const hit of page.results) hashes.push(hit.hash);
    skip += page.results.length;
    if (page.next_skip === null) break;
  }
  return { hashes: hashes.slice(0, topK), total: Number.isFinite(total) ? total : hashes.length, calls };
}
