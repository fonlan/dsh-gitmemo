/**
 * dsh-gitmemo — System-one recall gate.
 *
 * Optional narrowing stage for `mem_search`. After the engine produces a page
 * of lexical candidates, a System-one model (TypeSafe Jev by default, or any
 * endpoint speaking the same request/answer contract) is asked one typed
 * question per candidate, in a single request. Candidates the model judges
 * irrelevant are dropped from the page the root agent sees, which cuts the
 * tokens injected into the conversation.
 *
 * Design rules (deliberate, see README):
 *  - FAIL-OPEN: the gate may only ever REMOVE noise. Any transport, HTTP,
 *    timeout, or parse failure keeps every candidate and reports `degraded`,
 *    so a broken or unconfigured endpoint can never hide a memory.
 *  - NEVER EMPTY: when the gate would drop every candidate on a page, the
 *    `minKeep` best-ranked candidates are retained. A filter that silently
 *    returns nothing is indistinguishable from "no memory exists", which is
 *    the one failure mode a recall path must not have.
 *  - AUDITABLE: per-candidate values and the keep/drop verdict are returned in
 *    the tool output's `gated` block, so the decision can be inspected rather
 *    than trusted.
 *
 * This module imports nothing from the harness and performs no I/O of its own
 * beyond `fetch`, so it is unit-testable with a fake fetch implementation.
 *
 * @module dsh-gitmemo/systemone
 */

/** Question types this gate can drive. */
export type SystemOneMode = "noul" | "score";

/** One candidate memory offered to the gate. */
export interface GateCandidate {
  /** Commit hash — the identity used to keep/drop the candidate. */
  hash: string;
  /** Entry title (commit subject). */
  title: string;
  /** Entry summary (commit body). */
  summary: string;
  /** Structured keywords stored with the entry. */
  keywords: string[];
  /** Entry kind: `task` or `topic`. */
  kind: string;
}

/** Resolved gate settings for one search. */
export interface GateOptions {
  /** Absolute endpoint URL accepting the System-one request contract. */
  endpoint: string;
  /** Model identifier sent in the request body (e.g. `jev-latest`). */
  model: string;
  /** Question type used to judge each candidate. */
  mode: SystemOneMode;
  /** noul mode: keep a candidate when its probability is >= this value (0..1). */
  threshold: number;
  /** score mode: keep a candidate when its score is >= this value. */
  scoreMin: number;
  /** Retain at least this many candidates when the model rejects the whole page. */
  minKeep: number;
  /** What the caller does with the values; see {@link GatePolicy}. */
  policy?: GatePolicy;
  /**
   * `filter` policy only: never drop more than this fraction of the judged page,
   * lowest-scoring first. Bounds the damage a mis-calibrated threshold can do —
   * an offline sweep kept recall_all@5 at 0.8875 with a 20 % cap, against 0.6875
   * uncapped. Default 0.25.
   */
  maxDropFraction?: number;
  /** Never send more than this many candidates in one request. */
  maxCandidates: number;
  /** Truncate the task text to this many characters. */
  maxTaskChars: number;
  /** End-to-end request deadline in milliseconds. */
  timeoutMs: number;
  /** Literal API key, when one is configured in the settings section. */
  apiKey?: string;
  /** Late-bound credential lookup, used when no literal key is configured. */
  resolveApiKey?: () => Promise<string | undefined>;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * One candidate's verdict, retained for auditability.
 *
 * `value` is `null` when no readable answer came back for that candidate;
 * `null` rather than `NaN` because the harness rejects non-finite numbers in
 * session events and tool output must stay losslessly JSON-serializable.
 */
export interface GateVerdict {
  hash: string;
  /** Probability (noul) or score (score) returned for this candidate, or null. */
  value: number | null;
  /** Whether the candidate survived the gate. */
  keep: boolean;
}

/** Token accounting reported by the endpoint, when it reports any. */
export interface GateUsage {
  /** Input tokens billed for the request (Jev bills input only). */
  inputTokens?: number;
  /** Output tokens; free on Jev, but reported. */
  outputTokens?: number;
}

/** Outcome of one gate evaluation. */
export interface GateDecision {
  /** Hashes retained, in their original order. */
  kept: string[];
  /** Hashes removed, in their original order. */
  dropped: string[];
  /** Per-candidate verdicts, in candidate order. */
  verdicts: GateVerdict[];
  /** Policy actually applied; see {@link GatePolicy}. */
  policy: GatePolicy;
  /** True when `maxDropFraction` restored candidates a threshold would have removed. */
  bounded: boolean;
  /**
   * Candidate hashes ordered by the judge's value, best first (nulls last and
   * kept stable). This is what the `rerank` policy applies; in `filter` mode it
   * is still reported so a caller can log or inspect the judge's ordering.
   */
  ordered: string[];
  /** Question type actually used. */
  mode: SystemOneMode;
  /** Model identifier the request named. */
  model: string;
  /** True when the gate failed open (every candidate retained as a result). */
  degraded: boolean;
  /**
   * Why the gate degraded — or, on a `false` {@link degraded} page, that it
   * floored: no candidate cleared the threshold and `minKeep` was applied.
   */
  reason?: string;
  /**
   * Candidates actually sent to the endpoint, i.e. `min(maxCandidates, page
   * size)`. Reported separately from the page size so a truncated judgement is
   * never mistaken for a full one.
   */
  judged: number;
  /**
   * Candidates past `maxCandidates`, which were never evaluated and therefore
   * can never be dropped. Always `0` unless the page exceeded the cap.
   */
  untouched: number;
  /** Endpoint-reported token usage, so the gate's own cost is observable. */
  usage?: GateUsage;
}

/** Score levels offered to the model in `score` mode (ordered low to high). */
export const SCORE_LEVELS = [
  "unrelated to the task",
  "same general area but not actionable for this task",
  "partially relevant background",
  "substantially relevant and worth reusing",
  "directly reusable conclusions for this exact task"
] as const;

/**
 * The judgement asked of the model, verbatim. Kept in English on purpose:
 * Jev's primary training language is English and the vendor documents lower
 * accuracy for other scripts, so only the (possibly CJK) candidate text and
 * task text are non-English.
 */
export const NOUL_INSTRUCTION =
  "Does the `candidate` memory record contain conclusions, decisions, constraints, or reusable findings that are directly relevant to the `task`? Answer yes only if reading that memory would inform or change how the task is carried out. Answer no when it is merely on a related topic, is superseded, or concerns a different area.";

/**
 * Clarifies what yes and no mean for {@link NOUL_INSTRUCTION}.
 *
 * A noul `criteria` is an object with exactly `true` and `false` keys — a bare
 * string is rejected by the endpoint's validation, so this shape is required.
 */
export const NOUL_CRITERIA = {
  true: "yes — the memory is directly reusable for this task",
  false: "no — unrelated, superseded, or only loosely related to this task"
} as const;

/** The judgement asked of the model in `score` mode. */
export const SCORE_INSTRUCTION =
  "How relevant is the `candidate` memory record to the `task`? Rate how reusable its conclusions, decisions, constraints, or findings are for this exact task.";

/**
 * What the caller does with the judge's values.
 *
 * - `rerank` (default): keep every judged candidate and let the values reorder
 *   the page. Cannot lose a memory by construction.
 * - `filter`: drop candidates below the threshold, then apply `maxDropFraction`.
 *
 * Measured on LongMemEval `_S` (500 questions, identical ingested memories): at
 * threshold 0.5 the filter held 343 gold memories out of the prompt across 254
 * instances and took LLM-as-Judge from 0.7840 to 0.3800, while the same values
 * used as a reranker scored 0.8020 on the same context. The judge's AUC is only
 * ~0.71-0.75, so no threshold can make a hard drop safe; the same signal is a
 * fine ordering feature. See evals/longmemeval/README.md.
 */
export type GatePolicy = "rerank" | "filter";

/** Accepted `policy` values, for config validation and tool schemas. */
export const GATE_POLICIES: readonly GatePolicy[] = ["rerank", "filter"];

/** Trim a candidate summary before it is sent to the model. */
function clamp(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, limit) + "…" : collapsed;
}

/**
 * Build the System-one request body: the task is the shared `state`, and each
 * candidate travels inside its own question's structured `instructions`, so
 * every candidate is judged against the same task in one request and no
 * candidate payload is repeated across questions.
 *
 * @param task - the agent's current task, used as the shared state.
 * @param candidates - candidates to judge, already capped by the caller.
 * @param options - resolved gate settings.
 * @returns a JSON-serializable request body.
 */
export function buildRequest(
  task: string,
  candidates: readonly GateCandidate[],
  options: Pick<GateOptions, "mode" | "model" | "maxTaskChars">
): { state: { task: string }; model: string; questions: Record<string, unknown> } {
  const questions: Record<string, unknown> = {};
  const taskText = clamp(task, options.maxTaskChars);
  candidates.forEach((candidate, index) => {
    const payload = {
      title: candidate.title,
      summary: clamp(candidate.summary, 1200),
      keywords: candidate.keywords,
      kind: candidate.kind
    };
    questions["m" + index] =
      options.mode === "noul"
        ? {
            type: "noul",
            criteria: NOUL_CRITERIA,
            instructions: { question: NOUL_INSTRUCTION, candidate: payload }
          }
        : {
            type: "score",
            criteria: [...SCORE_LEVELS],
            instructions: { question: SCORE_INSTRUCTION, candidate: payload }
          };
  });
  return { state: { task: taskText }, model: options.model, questions };
}

/**
 * Extract one numeric answer per question id from a System-one response.
 *
 * Tolerates both documented envelope shapes (a top-level map of answers, or
 * the same map nested under `answers`) and both `noul`/`score` field spellings,
 * so an endpoint that is merely contract-compatible still works.
 *
 * @param payload - parsed response JSON.
 * @param mode - the question type that was asked.
 * @param count - number of questions sent (ids are `m0`..`m<count-1>`).
 * @returns the value per question index, or undefined where absent/unreadable.
 */
export function parseAnswers(
  payload: unknown,
  mode: SystemOneMode,
  count: number
): Array<number | undefined> {
  const envelope = payload as { answers?: unknown } | null | undefined;
  const map =
    envelope !== null && typeof envelope === "object" && envelope.answers !== undefined
      ? envelope.answers
      : payload;
  const record = (map ?? {}) as Record<string, unknown>;
  const values: Array<number | undefined> = [];
  for (let index = 0; index < count; index += 1) {
    const answer = (record["m" + index] ?? {}) as Record<string, unknown>;
    const raw = mode === "noul" ? (answer.noul ?? answer.probability) : answer.score;
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    values.push(value);
  }
  return values;
}

/**
 * Read the endpoint's token accounting.
 *
 * @param payload - parsed response JSON.
 * @returns camel-cased usage, or undefined when the endpoint reported none.
 */
export function parseUsage(payload: unknown): GateUsage | undefined {
  const usage = (payload as { usage?: unknown } | null | undefined)?.usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const input = typeof record.input_tokens === "number" ? record.input_tokens : undefined;
  const output = typeof record.output_tokens === "number" ? record.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output })
  };
}

/**
 * Turn per-candidate values into a keep/drop decision.
 *
 * Applies the configured threshold, then the `minKeep` floor that guarantees a
 * non-empty page whenever candidates existed. Candidates with a missing or
 * unreadable answer are KEPT (fail-open at the per-candidate level).
 *
 * @param candidates - candidates in page order.
 * @param values - value per candidate index (undefined when unreadable).
 * @param options - resolved gate settings.
 * @returns kept/dropped hash lists and per-candidate verdicts.
 */
export function decide(
  candidates: readonly GateCandidate[],
  values: ReadonlyArray<number | undefined>,
  options: Pick<GateOptions, "mode" | "threshold" | "scoreMin" | "minKeep" | "policy" | "maxDropFraction">
): { kept: string[]; dropped: string[]; verdicts: GateVerdict[]; floored: boolean; bounded: boolean } {
  // `decide` is the low-level primitive: with no explicit policy it applies the
  // literal threshold semantics, and with no explicit bound it applies none. The
  // product policy (rerank by default, 25 % drop cap) lives in the config layer,
  // which passes both in explicitly — the same split as `minKeep`.
  const policy: GatePolicy = options.policy ?? "filter";
  const cutoff = options.mode === "noul" ? options.threshold : options.scoreMin;
  if (policy === "rerank") {
    // Reordering cannot lose a memory: report every judged candidate as kept and
    // let `ordered` carry the ranking. The threshold verdict is still visible in
    // each verdict's `value`.
    const all = candidates.map((candidate, index) => ({
      hash: candidate.hash,
      value: values[index] ?? null,
      keep: true
    }));
    return {
      kept: candidates.map((c) => c.hash),
      dropped: [],
      verdicts: all,
      floored: false,
      bounded: false
    };
  }
  const verdicts: GateVerdict[] = candidates.map((candidate, index) => {
    const value = values[index];
    if (value === undefined) return { hash: candidate.hash, value: null, keep: true };
    return { hash: candidate.hash, value, keep: value >= cutoff };
  });

  let kept = verdicts.filter((v) => v.keep).map((v) => v.hash);
  let floored = false;
  if (kept.length === 0 && candidates.length > 0 && options.minKeep > 0) {
    const ranked = verdicts
      .map((verdict, index) => ({ verdict, index }))
      .sort((a, b) => {
        const av = a.verdict.value ?? Number.NEGATIVE_INFINITY;
        const bv = b.verdict.value ?? Number.NEGATIVE_INFINITY;
        return bv - av || a.index - b.index;
      })
      .slice(0, Math.min(options.minKeep, candidates.length));
    const promoted = new Set(ranked.map((entry) => entry.verdict.hash));
    for (const verdict of verdicts) {
      if (promoted.has(verdict.hash)) verdict.keep = true;
    }
    kept = verdicts.filter((v) => v.keep).map((v) => v.hash);
    floored = true;
  }

  // Bound the damage: a threshold that rejects most of a page is far more
  // likely to be mis-calibrated than the page is to be mostly irrelevant, and
  // the cost of the two errors is not symmetric — a dropped memory is gone,
  // a kept one only costs context. Restore the best-scoring rejects until the
  // drop share is within `maxDropFraction`.
  let bounded = false;
  const maxDropFraction = options.maxDropFraction ?? 1;
  if (candidates.length > 0 && maxDropFraction < 1) {
    const allowedDrops = Math.max(0, Math.floor(candidates.length * Math.max(0, maxDropFraction)));
    const dropCount = candidates.length - kept.length;
    if (dropCount > allowedDrops) {
      const restoreCount = dropCount - allowedDrops;
      const rejects = verdicts
        .map((verdict, index) => ({ verdict, index }))
        .filter((entry) => !entry.verdict.keep)
        .sort((a, b) => {
          const av = a.verdict.value ?? Number.NEGATIVE_INFINITY;
          const bv = b.verdict.value ?? Number.NEGATIVE_INFINITY;
          return bv - av || a.index - b.index;
        })
        .slice(0, restoreCount);
      for (const entry of rejects) entry.verdict.keep = true;
      kept = verdicts.filter((v) => v.keep).map((v) => v.hash);
      bounded = true;
    }
  }

  const keptSet = new Set(kept);
  return {
    kept,
    dropped: candidates.map((c) => c.hash).filter((hash) => !keptSet.has(hash)),
    verdicts,
    floored,
    bounded
  };
}

/** Combine a caller signal with a timeout, keeping both cancellation sources. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Evaluate the gate for one search page.
 *
 * Never throws and never returns an empty `kept` list while candidates exist:
 * every failure path degrades to "keep everything" with a reason.
 *
 * @param task - the agent's current task text (shared state).
 * @param candidates - page candidates; only the first `maxCandidates` are judged.
 * @param options - resolved gate settings.
 * @param signal - caller cancellation.
 * @returns the decision to apply to the page.
 */
export async function evaluateGate(
  task: string,
  candidates: readonly GateCandidate[],
  options: GateOptions,
  signal?: AbortSignal
): Promise<GateDecision> {
  const mode = options.mode;
  const policy: GatePolicy = options.policy ?? "rerank";
  const base = {
    mode,
    model: options.model,
    policy,
    bounded: false
  };

  if (candidates.length === 0) {
    return { ...base, kept: [], dropped: [], verdicts: [], ordered: [], judged: 0, untouched: 0, degraded: false };
  }

  const judged = candidates.slice(0, Math.max(1, options.maxCandidates));
  const untouched = candidates.slice(judged.length);
  const keepAll = (reason: string): GateDecision => ({
    ...base,
    kept: candidates.map((c) => c.hash),
    dropped: [],
    verdicts: candidates.map((c) => ({ hash: c.hash, value: null, keep: true })),
    ordered: candidates.map((c) => c.hash),
    judged: judged.length,
    untouched: untouched.length,
    degraded: true,
    reason
  });

  let apiKey: string | undefined;
  try {
    apiKey =
      options.apiKey !== undefined && options.apiKey.length > 0
        ? options.apiKey
        : await options.resolveApiKey?.();
  } catch {
    apiKey = undefined;
  }
  if (apiKey === undefined || apiKey.length === 0) {
    return keepAll("no API key configured for the system-one endpoint");
  }

  const body = buildRequest(task, judged, options);
  let payload: unknown;
  try {
    const response = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey
      },
      body: JSON.stringify(body),
      signal: withTimeout(signal, options.timeoutMs)
    });
    if (!response.ok) {
      return keepAll("system-one endpoint returned HTTP " + response.status);
    }
    payload = await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return keepAll("system-one request failed: " + detail);
  }

  const values = parseAnswers(payload, mode, judged.length);
  const decision = decide(judged, values, { ...options, policy });
  // Candidates past `maxCandidates` were never evaluated, so they are never
  // removed: the gate may only drop what it actually judged. Leaving them out
  // of the kept set would silently truncate every page larger than the cap.
  const keptSet = new Set([...decision.kept, ...untouched.map((c) => c.hash)]);
  const verdicts: GateVerdict[] = [
    ...decision.verdicts,
    ...untouched.map((c) => ({ hash: c.hash, value: null, keep: true }))
  ];
  // Best value first; nulls (unjudged / unreadable) keep page order at the end.
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index, value: verdicts[index]?.value ?? null }))
    .sort((a, b) => {
      if (a.value === b.value) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return b.value - a.value;
    })
    .map((entry) => entry.candidate.hash);
  const usage = parseUsage(payload);
  return {
    ...base,
    ordered,
    bounded: decision.bounded,
    kept: [...candidates.map((c) => c.hash).filter((hash) => keptSet.has(hash))],
    dropped: decision.dropped,
    verdicts,
    judged: judged.length,
    untouched: untouched.length,
    degraded: false,
    ...(usage === undefined ? {} : { usage }),
    ...(decision.floored
      ? { reason: "no candidate scored above the threshold; retained top " + decision.kept.length }
      : decision.bounded
        ? { reason: "threshold would have dropped more than maxDropFraction; restored the best-scoring rejects" }
        : {})
  };
}
