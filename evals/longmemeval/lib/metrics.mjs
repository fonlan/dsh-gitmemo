/**
 * Faithful JavaScript port of LongMemEval's official retrieval metrics.
 *
 * Source of truth (MIT-licensed upstream, mirrored here so the harness has no
 * Python dependency): `src/retrieval/eval_utils.py` in
 * https://github.com/xiaowu0162/LongMemEval
 *
 *   def evaluate_retrieval(rankings, correct_docs, corpus_ids, k):
 *       recalled_docs = set(corpus_ids[idx] for idx in rankings[:k])
 *       recall_any = float(any(doc in recalled_docs for doc in correct_docs))
 *       recall_all = float(all(doc in recalled_docs for doc in correct_docs))
 *       ndcg_score = ndcg(rankings, correct_docs, corpus_ids, k)
 *
 * Semantics preserved on purpose (including the edge cases):
 *  - `rankings` are indices into `corpus_ids`, not ids.
 *  - Empty gold set: recall_any = 0 (`any([]) == False`) but recall_all = 1
 *    (`all([]) == True`); NDCG is 0 because ideal DCG is 0.
 */

/** Discounted Cumulative Gain at k (same arithmetic as upstream's `dcg`). */
export function dcg(relevances, k) {
  const r = relevances.slice(0, k);
  if (r.length === 0) return 0;
  let sum = r[0];
  for (let i = 2; i <= r.length; i += 1) sum += r[i - 1] / Math.log2(i);
  return sum;
}

/** Normalized DCG at k with binary relevance over the full corpus. */
export function ndcg(rankings, correctDocs, corpusIds, k) {
  const relevance = corpusIds.map((id) => (correctDocs.has(id) ? 1 : 0));
  const rankedRelevance = rankings.slice(0, k).map((idx) => relevance[idx]);
  const idealRelevance = [...relevance].sort((a, b) => b - a);
  const idealDcg = dcg(idealRelevance, k);
  if (idealDcg === 0) return 0;
  return dcg(rankedRelevance, k) / idealDcg;
}

/** `evaluate_retrieval` — returns { recallAny, recallAll, ndcg }. */
export function evaluateRetrieval(rankings, correctDocs, corpusIds, k) {
  const recalled = new Set(rankings.slice(0, k).map((idx) => corpusIds[idx]));
  let recallAny = 0;
  for (const doc of correctDocs) {
    if (recalled.has(doc)) {
      recallAny = 1;
      break;
    }
  }
  let recallAll = 1;
  for (const doc of correctDocs) {
    if (!recalled.has(doc)) {
      recallAll = 0;
      break;
    }
  }
  return { recallAny, recallAll, ndcg: ndcg(rankings, correctDocs, corpusIds, k) };
}

/** Upstream `strip_turn_id`: drop the trailing `_<turn index>` segment. */
export function stripTurnId(docId) {
  const parts = docId.split("_");
  return parts.slice(0, -1).join("_");
}

/**
 * Upstream `evaluate_retrieval_turn2session`: collapse turn-level ids to
 * session level and widen k until k *distinct* sessions are covered.
 */
export function evaluateRetrievalTurn2Session(rankings, correctDocs, corpusIds, k) {
  const goldSessions = new Set([...correctDocs].map(stripTurnId));
  const sessionCorpus = corpusIds.map(stripTurnId);
  let effectiveK = k;
  const unique = () => new Set(rankings.slice(0, effectiveK).map((idx) => sessionCorpus[idx]));
  let uniq = unique();
  while (effectiveK <= sessionCorpus.length && uniq.size < k) {
    effectiveK += 1;
    uniq = unique();
  }
  return evaluateRetrieval(rankings, goldSessions, sessionCorpus, effectiveK);
}

/** The k values upstream evaluates (run_retrieval.py: `for k in [1, 3, 5, 10, 30, 50]`). */
export const K_VALUES = [1, 3, 5, 10, 30, 50];

/**
 * Compute the full metric block for one ranking under one granularity.
 * `granularity` = "session" fills only `session`; "turn" fills `turn` and a
 * session-level block derived through the turn→session collapse (exactly what
 * upstream does).
 */
export function computeMetrics(rankings, correctDocs, corpusIds, granularity) {
  const out = { session: {}, turn: {} };
  for (const k of K_VALUES) {
    const { recallAny, recallAll, ndcg: nd } = evaluateRetrieval(rankings, correctDocs, corpusIds, k);
    out[granularity][`recall_any@${k}`] = recallAny;
    out[granularity][`recall_all@${k}`] = recallAll;
    out[granularity][`ndcg_any@${k}`] = nd;
    if (granularity === "turn") {
      const s = evaluateRetrievalTurn2Session(rankings, correctDocs, corpusIds, k);
      out.session[`recall_any@${k}`] = s.recallAny;
      out.session[`recall_all@${k}`] = s.recallAll;
      out.session[`ndcg_any@${k}`] = s.ndcg;
    }
  }
  return out;
}

/** Mean of a metric across instances (upstream uses plain `np.mean`). */
export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate per-question metric blocks the way `print_retrieval_metrics.py`
 * does: skip abstention instances (`_abs`), mean each metric over the rest,
 * and additionally bucket by question type.
 */
export function aggregate(records) {
  const nonAbstention = records.filter((r) => !r.question_id.includes("_abs"));
  const byType = new Map();
  for (const r of nonAbstention) {
    if (!byType.has(r.question_type)) byType.set(r.question_type, []);
    byType.get(r.question_type).push(r);
  }
  const summarize = (rows, granularity) => {
    const block = {};
    for (const k of K_VALUES) {
      for (const metric of ["recall_any", "recall_all", "ndcg_any"]) {
        const key = `${metric}@${k}`;
        const values = rows
          .map((r) => r.metrics?.[granularity]?.[key])
          .filter((v) => typeof v === "number");
        if (values.length > 0) block[key] = +mean(values).toFixed(6);
      }
    }
    return block;
  };
  const overall = { n: nonAbstention.length, session: summarize(nonAbstention, "session"), turn: summarize(nonAbstention, "turn") };
  const types = {};
  for (const [type, rows] of [...byType.entries()].sort()) {
    types[type] = {
      n: rows.length,
      session: summarize(rows, "session"),
      turn: summarize(rows, "turn"),
      gold_free: rows.filter((r) => r.gold_count === 0).length
    };
  }
  return {
    overall,
    types,
    abstention: {
      n: records.length - nonAbstention.length,
      gold_free: records.filter((r) => r.question_id.includes("_abs") && r.gold_count === 0).length
    },
    gold_free_non_abstention: nonAbstention.filter((r) => r.gold_count === 0).length
  };
}
