/**
 * LongMemEval dataset loading + the official corpus/gold construction.
 *
 * Mirrors `process_item_flat_index` and `batch_get_retrieved_context_and_eval`
 * (step 1/2) from https://github.com/xiaowu0162/LongMemEval
 * `src/retrieval/run_retrieval.py`, including the parts that are easy to get
 * wrong:
 *
 *  - Session granularity indexes ONLY the **user** turns of a session, joined
 *    by spaces — not the assistant reply.
 *  - A session whose id contains "answer" but that holds no user turn with
 *    `has_answer: true` is relabelled "noans" and therefore is NOT gold.
 *  - Gold is then simply "any corpus id containing the substring `answer`".
 *    The `answer_session_ids` field is deliberately NOT used: on the released
 *    cleaned splits it over-lists 145 sessions (see README), which would
 *    penalise a correct retriever.
 *  - Turn granularity indexes every user turn; ids are
 *    `<session_id>_<1-based index over ALL turns>`.
 */
import { readFileSync } from "node:fs";

export function loadSplit(path) {
  const entries = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(entries)) throw new Error(`dataset: ${path} is not a JSON array`);
  return entries;
}

export function isAbstention(entry) {
  return entry.question_id.includes("_abs");
}

/** Python's `str.replace(a, b)` replaces every occurrence; `replaceAll` matches. */
function relabelNoans(id) {
  return id.replaceAll("answer", "noans");
}

/**
 * Build the retrieval corpus for one instance.
 *
 * @returns {{ corpusIds: string[], texts: string[], gold: Set<string>, goldIds: string[],
 *             slotToDocId: string[], docIdToSlot: Map<string, number>,
 *             sessionOfDocId: string[], dates: string[] }}
 */
export function buildCorpus(entry, granularity = "session") {
  const corpusIds = [];
  const texts = [];
  const sessionOfDocId = [];
  const dates = [];
  const slots = [];

  const sessionIds = entry.haystack_session_ids;
  const sessions = entry.haystack_sessions;
  const haystackDates = entry.haystack_dates ?? [];

  for (let s = 0; s < sessionIds.length; s += 1) {
    const sessionId = sessionIds[s];
    const turns = sessions[s];
    const date = haystackDates[s] ?? "";
    const hasAnswerInId = sessionId.includes("answer");

    if (granularity === "session") {
      const userTurns = turns.filter((t) => t.role === "user");
      const text = userTurns.map((t) => t.content).join(" ");
      const anyAnswerTurn = userTurns.some((t) => t.has_answer === true);
      const docId = hasAnswerInId && !anyAnswerTurn ? relabelNoans(sessionId) : sessionId;
      corpusIds.push(docId);
      texts.push(text);
      sessionOfDocId.push(sessionId);
      dates.push(date);
      slots.push({
        docId,
        sessionId,
        sessionIndex: s,
        turnIndex: null,
        text,
        // Filler sessions imported from ShareGPT/UltraChat occasionally hold
        // assistant turns only, so the user-only text is empty — the official
        // corpus still contains that (unretrievable) item, but a memory writer
        // would still record the session, so keep the full transcript as a
        // fallback for the ingest side.
        fallbackText: turns.map((t) => t.content).join(" "),
        date,
        turns
      });
    } else if (granularity === "turn") {
      for (let i = 0; i < turns.length; i += 1) {
        const turn = turns[i];
        if (turn.role !== "user") continue;
        let id = `${sessionId}_${i + 1}`;
        if (!hasAnswerInId) {
          // plain filler session: id keeps no "answer" substring
        } else if (turn.has_answer === true) {
          // gold turn: id keeps "answer"
        } else {
          if (turn.has_answer !== false) {
            throw new Error(`dataset: session ${sessionId} turn ${i + 1} lacks a has_answer flag`);
          }
          id = relabelNoans(id);
        }
        corpusIds.push(id);
        texts.push(turn.content);
        sessionOfDocId.push(sessionId);
        dates.push(date);
        slots.push({
          docId: id,
          sessionId,
          sessionIndex: s,
          turnIndex: i,
          text: turn.content,
          fallbackText: turn.content,
          date,
          turns: [turn]
        });
      }
    } else {
      throw new Error(`dataset: unknown granularity ${granularity}`);
    }
  }

  const gold = new Set(corpusIds.filter((id) => id.includes("answer")));
  return {
    corpusIds,
    texts,
    gold,
    goldIds: [...gold],
    slots,
    sessionOfDocId,
    dates,
    docIdToSlot: new Map(corpusIds.map((id, idx) => [id, idx]))
  };
}

/**
 * Full ranking in the official index space: retrieved doc ids first (in rank
 * order), then every remaining corpus document. NDCG needs the full corpus, so
 * a partial top-k alone is not enough.
 */
export function buildRankings(rankedDocIds, corpusIds) {
  const seen = new Set();
  const rankings = [];
  const slot = new Map(corpusIds.map((id, idx) => [id, idx]));
  for (const id of rankedDocIds) {
    const idx = slot.get(id);
    if (idx === undefined || seen.has(idx)) continue;
    seen.add(idx);
    rankings.push(idx);
  }
  for (let i = 0; i < corpusIds.length; i += 1) if (!seen.has(i)) rankings.push(i);
  return rankings;
}

/** Compact stats used for the report header. */
export function splitStats(entries) {
  const sessions = entries.map((e) => e.haystack_sessions.length).sort((a, b) => a - b);
  const types = {};
  let abstention = 0;
  let userTurns = 0;
  let answerTurns = 0;
  for (const e of entries) {
    types[e.question_type] = (types[e.question_type] ?? 0) + 1;
    if (isAbstention(e)) abstention += 1;
    for (const session of e.haystack_sessions) {
      for (const turn of session) {
        if (turn.role !== "user") continue;
        userTurns += 1;
        if (turn.has_answer === true) answerTurns += 1;
      }
    }
  }
  return {
    instances: entries.length,
    sessions_total: sessions.reduce((a, b) => a + b, 0),
    sessions_min: sessions[0] ?? 0,
    sessions_median: sessions[Math.floor(sessions.length / 2)] ?? 0,
    sessions_max: sessions[sessions.length - 1] ?? 0,
    user_turns: userTurns,
    answer_turns: answerTurns,
    abstention,
    question_types: types
  };
}
