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
export declare const SCORE_LEVELS: readonly ["unrelated to the task", "same general area but not actionable for this task", "partially relevant background", "substantially relevant and worth reusing", "directly reusable conclusions for this exact task"];
/**
 * The judgement asked of the model, verbatim. Kept in English on purpose:
 * Jev's primary training language is English and the vendor documents lower
 * accuracy for other scripts, so only the (possibly CJK) candidate text and
 * task text are non-English.
 */
export declare const NOUL_INSTRUCTION = "Does the `candidate` memory record contain conclusions, decisions, constraints, or reusable findings that are directly relevant to the `task`? Answer yes only if reading that memory would inform or change how the task is carried out. Answer no when it is merely on a related topic, is superseded, or concerns a different area.";
/**
 * Clarifies what yes and no mean for {@link NOUL_INSTRUCTION}.
 *
 * A noul `criteria` is an object with exactly `true` and `false` keys — a bare
 * string is rejected by the endpoint's validation, so this shape is required.
 */
export declare const NOUL_CRITERIA: {
    readonly true: "yes — the memory is directly reusable for this task";
    readonly false: "no — unrelated, superseded, or only loosely related to this task";
};
/** The judgement asked of the model in `score` mode. */
export declare const SCORE_INSTRUCTION = "How relevant is the `candidate` memory record to the `task`? Rate how reusable its conclusions, decisions, constraints, or findings are for this exact task.";
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
export declare function buildRequest(task: string, candidates: readonly GateCandidate[], options: Pick<GateOptions, "mode" | "model" | "maxTaskChars">): {
    state: {
        task: string;
    };
    model: string;
    questions: Record<string, unknown>;
};
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
export declare function parseAnswers(payload: unknown, mode: SystemOneMode, count: number): Array<number | undefined>;
/**
 * Read the endpoint's token accounting.
 *
 * @param payload - parsed response JSON.
 * @returns camel-cased usage, or undefined when the endpoint reported none.
 */
export declare function parseUsage(payload: unknown): GateUsage | undefined;
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
export declare function decide(candidates: readonly GateCandidate[], values: ReadonlyArray<number | undefined>, options: Pick<GateOptions, "mode" | "threshold" | "scoreMin" | "minKeep">): {
    kept: string[];
    dropped: string[];
    verdicts: GateVerdict[];
    floored: boolean;
};
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
export declare function evaluateGate(task: string, candidates: readonly GateCandidate[], options: GateOptions, signal?: AbortSignal): Promise<GateDecision>;
