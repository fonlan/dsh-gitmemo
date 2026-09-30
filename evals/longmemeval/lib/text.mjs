/**
 * Deterministic text utilities: tokenisation, IDF weights, BM25 ranking, and
 * the heuristic keyword extractors used by the gitmemo adapter.
 *
 * Why a heuristic exists at all: `mem_write` requires the writer to supply
 * 2–12 keywords and `mem_search` requires 1–15 query keywords, and the engine
 * searches ONLY the commit-message projections (title / summary / keywords) —
 * entry bodies are never scanned. An eval harness therefore has to stand in
 * for the agent that would normally choose those keywords. Every strategy is
 * named and reported, so the numbers are attributable.
 */

/** Minimal English stopword list (kept short and explicit — no dependency). */
export const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such than that that's the their theirs them themselves then there these they this those through to too under until up very was wasn't we were weren't what when where which while who whom why with won't would wouldn't you your yours yourself yourselves
   also just really maybe going get got want wanted like know think thought going make made take took thing things stuff kind sort lot bit today yesterday tomorrow now then still even much many way ways time times day days week weeks month months year years
   actually almost already always another around back bad become became been being better best big came come comes could course day didn different done down end even every everything far feel felt find first found get give given go going good great got guess guy guys half hand happen happened hard hear heard help here hey hi hope hopefully huh important interesting keep keeps kept last later least leave left let little long look looking looks made many mean means might mine moment month much must name need needed needs never new next nice night nothing ok okay old ones open other others part people perhaps person place please pretty probably problem put quite right said same saw say says second see seem seems seen several should show side since sit small someone something sometimes soon sorry sort start started still sure Take talk talked tell tells thank thanks thats thats their there theres these they thing think this those though thought three time times told took top try trying turn turns two understand until use used uses using usually wait waiting want wanted wants watch way well went weve whats when where which while who whole why will wish without work working works would wrong yeah year yes yet you youd youll youre youve`
    .split(/\s+/)
    .filter(Boolean)
);

const TOKEN_RE = /[a-z0-9]+/g;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/** Lowercase NFKC tokenisation; CJK runs are kept as single tokens. */
export function tokenize(text) {
  if (!text) return [];
  const normalized = String(text).normalize("NFKC").toLowerCase();
  const out = [];
  const cjkRuns = normalized.match(new RegExp(CJK_RE.source + "+", "g"));
  if (cjkRuns) out.push(...cjkRuns);
  const latin = normalized.replace(new RegExp(CJK_RE.source, "g"), " ");
  const matches = latin.match(TOKEN_RE);
  if (matches) out.push(...matches);
  return out;
}

export function contentTokens(text) {
  return tokenize(text).filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Inverse document frequency over one instance's corpus (the sessions visible
 * to the ingestion step). Used only by the heuristic extractors.
 */
export function corpusStats(corpusTexts) {
  const df = new Map();
  const docTokens = corpusTexts.map((text) => {
    const tokens = contentTokens(text);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    return tokens;
  });
  const n = corpusTexts.length || 1;
  return { df, idf: idfFromDf(df, n), n, docTokens };
}

/**
 * BM25-style IDF from a document-frequency map. Exposed separately so the
 * online ingestion path (which accumulates `df` one session at a time and must
 * not rescan the whole history) uses exactly the same formula.
 */
export function idfFromDf(df, n) {
  const idf = new Map();
  const docs = n || 1;
  for (const [term, freq] of df) idf.set(term, Math.log(1 + (docs - freq + 0.5) / (freq + 0.5)));
  return idf;
}


/**
 * Ingest-side keywords: the `maxKeywords` most distinctive terms of the item.
 *
 * Scoring is BM25-style `idf × tf/(tf + k1)`: the saturation matters a lot
 * here. A plain `tf × idf` rank rewards whatever a session happens to repeat
 * and buries a fact mentioned exactly once, which is precisely the evidence
 * LongMemEval asks about. Pass `score: "tfidf"` to reproduce the unsaturated
 * ranking for ablation.
 *
 * CAVEAT (documented in the README): the real ingestion step happens online
 * and could only use history-so-far statistics, whereas this uses the whole
 * instance corpus. That is a mild, uniform advantage for every retriever
 * compared here, not a gitmemo-specific one.
 */
export function ingestKeywords(text, stats, maxKeywords = 12, { score = "bm25", k1 = 1.2 } = {}) {
  const counts = new Map();
  for (const token of contentTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const scored = [...counts.entries()]
    .map(([term, tf]) => {
      const idf = stats.idf.get(term) ?? Math.log(1 + stats.n);
      const weight = score === "tfidf" ? tf : (tf * (k1 + 1)) / (tf + k1);
      return { term, tf, score: weight * idf };
    })
    .filter((x) => x.term.length >= 3 && x.term.length <= 48)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const picked = scored.slice(0, maxKeywords).map((x) => x.term);
  // mem_write requires at least 2 keywords; pad deterministically if needed.
  for (const filler of ["conversation", "note", "detail", "session"]) {
    if (picked.length >= 2) break;
    if (!picked.includes(filler)) picked.push(filler);
  }
  return picked;
}

/**
 * Deterministic extractive summary — the stand-in for the "1–3 sentence
 * summary" that mem_write asks for.
 *
 * `prefix` keeps the opening of the session (what a naive truncation does);
 * `extractive` scores every sentence of the whole session by summed term
 * distinctiveness and keeps the best few in reading order, so a fact stated
 * halfway through a session still reaches the retrieval surface. Both are
 * named so the difference is measurable rather than asserted.
 */
export function extractiveSummary(text, stats, { sentences = 4, maxChars = 900 } = {}) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const parts = flat.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).filter((s) => s.trim().length > 0);
  if (parts.length <= 1) return flat.slice(0, maxChars);
  const scored = parts.map((sentence, index) => {
    const tokens = contentTokens(sentence);
    let score = 0;
    for (const token of new Set(tokens)) score += stats?.idf?.get(token) ?? 1;
    // Length-normalise so a long rambling sentence cannot win on bulk alone.
    return { index, sentence, score: score / Math.sqrt(Math.max(tokens.length, 1)) };
  });
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, sentences).sort((a, b) => a.index - b.index);
  let out = "";
  for (const item of top) {
    const candidate = out.length === 0 ? item.sentence : `${out} ${item.sentence}`;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  return out.length > 0 ? out : flat.slice(0, maxChars);
}

/**
 * Query-side keywords, the simulated `mem_search` call.
 *  - `plain`: the question's content words in reading order (≤ maxKeywords).
 *  - `idf`  : content words ranked by corpus IDF (upper-bound heuristic).
 */
export function queryKeywords(question, stats, mode = "plain", maxKeywords = 15) {
  const base = [...new Set(contentTokens(question))];
  if (mode === "idf" && stats) {
    base.sort((a, b) => (stats.idf.get(b) ?? 0) - (stats.idf.get(a) ?? 0) || a.localeCompare(b));
  }
  const picked = base.slice(0, maxKeywords);
  return picked.length > 0 ? picked : [question.trim().slice(0, 40).toLowerCase()];
}

/** A plausible `mem_write` summary for a session: the opening of the user's text. */
/**
 * Prefix summary: the opening of the item's text, hard-truncated at a word
 * boundary. Kept as the `prefix` ablation for `extractiveSummary`.
 */
export function summarize(text, maxChars = 400) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut) + " …";
}

/**
 * Strip the control characters the engine rejects (title / summary / content
 * are all validated with `/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/`).
 * Tab, LF and CR stay — they are legal and meaningful in a transcript.
 *
 * LongMemEval is built from scraped chat logs, so stray control bytes do occur;
 * the engine's rejection is correct, cleaning the input is the adapter's job
 * (the same reason OmniMemEval has `sanitize_lme_message_content`).
 */
export function sanitizeForEngine(text) {
  return String(text ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** A plausible `mem_write` title: a short topical phrase from the item's text. */
export function titleize(text, maxWords = 9) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "[session] empty";
  const words = flat.split(" ").slice(0, maxWords).join(" ").replace(/[|#]/g, " ");
  return `[session] ${words.slice(0, 180)}`;
}

/** BM25 ranking over the same corpus text the official flat-bm25 baseline uses. */
export function bm25Rank(query, corpusTexts, { k1 = 1.2, b = 0.75 } = {}) {
  const stats = corpusStats(corpusTexts);
  const docLengths = stats.docTokens.map((t) => t.length);
  const avgdl = docLengths.reduce((a, b2) => a + b2, 0) / (docLengths.length || 1);
  const queryTerms = [...new Set(contentTokens(query))];
  const scores = new Array(corpusTexts.length).fill(0);
  for (const term of queryTerms) {
    const idf = stats.idf.get(term);
    if (idf === undefined) continue;
    for (let d = 0; d < corpusTexts.length; d += 1) {
      const tokens = stats.docTokens[d];
      if (tokens.length === 0) continue;
      let tf = 0;
      for (const t of tokens) if (t === term) tf += 1;
      if (tf === 0) continue;
      const denom = tf + k1 * (1 - b + (b * docLengths[d]) / (avgdl || 1));
      scores[d] += idf * ((tf * (k1 + 1)) / denom);
    }
  }
  return scores
    .map((score, idx) => ({ score, idx }))
    .sort((a, b2) => b2.score - a.score || a.idx - b2.idx)
    .filter((x) => x.score > 0)
    .map((x) => x.idx);
}
