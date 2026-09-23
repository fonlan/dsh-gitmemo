/**
 * dsh-gitmemo — Git-backed long-term memory for DeepSeek Harness.
 *
 * A Cordis plugin mirroring gitmemo (https://github.com/fonlan/gitmemo):
 * the root agent stores completed task outcomes as immutable markdown
 * entries in a local `.mem` git repository (single `main` branch, structured
 * commit messages) and searches them before starting new work.
 *
 * Mechanism:
 *  - only ROOT agents (delegationDepth === 0) receive the gitmemo workflow
 *    section and the five `mem_*` tools, scoped into `agent.ctx` at
 *    `agent/created`; subagents carry neither (no token cost, no duplicate
 *    memory writes);
 *  - registration performs zero Git I/O;
 *  - no session-start seeding, no synchronous git runners, no branch
 *    alignment — `.mem` permanently stays on `main`;
 *  - the previous `mem_init` tool is gone from the model surface; legacy
 *    argument shapes are accepted for one version by the core engine
 *    compatibility adapter, while the model-facing schemas stay strict.
 *
 * @module dsh-gitmemo
 */
import z from "@deepseek-ai/schemastery";
/** Cordis plugin name. */
declare const name = "dsh-gitmemo";
/** Host services this plugin needs. */
declare const inject: string[];
/** Plugin configuration. */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** @deprecated — the memory dir is fixed at `<projectRoot>/.mem`; kept for one version. */
    memDirName: z<string, string, "defined">;
    /** Max search hits per mem_search call (page size). Default 20. */
    searchLimit: z<number, number, "defined">;
    /** @deprecated — `.mem` always stays on main; kept for one version, no effect. */
    branchAlign: z<boolean, boolean, "defined">;
    /** @deprecated — session-start recent seeding was removed; kept for one version, no effect. */
    recentContextLimit: z<number, number, "defined">;
    /** Cross-process lock wait timeout in milliseconds. Default 30000. */
    lockTimeoutMs: z<number, number, "defined">;
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string, "plain">;
    /**
     * Optional System-one recall gate. When an endpoint and a credential are
     * configured, each `mem_search` page is narrowed by a System-one model
     * (TypeSafe Jev by default) before it reaches the model; when nothing is
     * configured the gate is a no-op and recall behaves exactly as before.
     *
     * `.volatile()` is REQUIRED here, not cosmetic: the settings plane only
     * exposes a field that sits on or under a volatile node (`volatileForm()`
     * returns undefined otherwise, and `describe()` then skips this entry
     * entirely while `write()` throws). Verified against
     * `@deepseek-ai/dsh-settings`. Note that DSH 0.1.7-alpha.1 ships no client
     * that auto-generates a page from the schema, so this plugin also ships its
     * own settings card (see `src/client/`).
     */
    systemOne: z<Schemastery.ObjectS<NoInfer<{
        /** Master switch. Defaults to true; with no credential the gate stays a no-op. */
        enabled: z<boolean, boolean, "volatile-defined">;
        /** Endpoint accepting the System-one request contract. */
        endpoint: z<string, string, "volatile-defined">;
        /** Model identifier sent in the request body. */
        model: z<string, string, "volatile-defined">;
        /** Literal API key. Declared secret: redacted on every read, write-only in the form. */
        apiKey: z<string, string, "volatile">;
        /** Credential reference resolved through the credentials service, then the environment. */
        apiKeyEnv: z<string, string, "volatile-defined">;
        /** Question type used to judge each candidate. */
        mode: z<"noul" | "score", "noul" | "score", "volatile-defined">;
        /** noul mode: keep a candidate when its probability is at least this value. */
        threshold: z<number, number, "volatile-defined">;
        /** score mode: keep a candidate when its score is at least this value.
         * Jev's `score` is Σ(level_index × probability) over 0…levels−1, NOT 0–1;
         * with the default 5 levels the range is 0…4, where 2 = "partially relevant". */
        scoreMin: z<number, number, "volatile-defined">;
        /** Retain at least this many candidates when the model rejects an entire page. */
        minKeep: z<number, number, "volatile-defined">;
        /** Never judge more than this many candidates per request. */
        maxCandidates: z<number, number, "volatile-defined">;
        /** Truncate the task text to this many characters before sending it. */
        maxTaskChars: z<number, number, "volatile-defined">;
        /** End-to-end request deadline in milliseconds. */
        timeoutMs: z<number, number, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** Master switch. Defaults to true; with no credential the gate stays a no-op. */
        enabled: z<boolean, boolean, "volatile-defined">;
        /** Endpoint accepting the System-one request contract. */
        endpoint: z<string, string, "volatile-defined">;
        /** Model identifier sent in the request body. */
        model: z<string, string, "volatile-defined">;
        /** Literal API key. Declared secret: redacted on every read, write-only in the form. */
        apiKey: z<string, string, "volatile">;
        /** Credential reference resolved through the credentials service, then the environment. */
        apiKeyEnv: z<string, string, "volatile-defined">;
        /** Question type used to judge each candidate. */
        mode: z<"noul" | "score", "noul" | "score", "volatile-defined">;
        /** noul mode: keep a candidate when its probability is at least this value. */
        threshold: z<number, number, "volatile-defined">;
        /** score mode: keep a candidate when its score is at least this value.
         * Jev's `score` is Σ(level_index × probability) over 0…levels−1, NOT 0–1;
         * with the default 5 levels the range is 0…4, where 2 = "partially relevant". */
        scoreMin: z<number, number, "volatile-defined">;
        /** Retain at least this many candidates when the model rejects an entire page. */
        minKeep: z<number, number, "volatile-defined">;
        /** Never judge more than this many candidates per request. */
        maxCandidates: z<number, number, "volatile-defined">;
        /** Truncate the task text to this many characters before sending it. */
        maxTaskChars: z<number, number, "volatile-defined">;
        /** End-to-end request deadline in milliseconds. */
        timeoutMs: z<number, number, "volatile-defined">;
    }>>, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** @deprecated — the memory dir is fixed at `<projectRoot>/.mem`; kept for one version. */
    memDirName: z<string, string, "defined">;
    /** Max search hits per mem_search call (page size). Default 20. */
    searchLimit: z<number, number, "defined">;
    /** @deprecated — `.mem` always stays on main; kept for one version, no effect. */
    branchAlign: z<boolean, boolean, "defined">;
    /** @deprecated — session-start recent seeding was removed; kept for one version, no effect. */
    recentContextLimit: z<number, number, "defined">;
    /** Cross-process lock wait timeout in milliseconds. Default 30000. */
    lockTimeoutMs: z<number, number, "defined">;
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string, "plain">;
    /**
     * Optional System-one recall gate. When an endpoint and a credential are
     * configured, each `mem_search` page is narrowed by a System-one model
     * (TypeSafe Jev by default) before it reaches the model; when nothing is
     * configured the gate is a no-op and recall behaves exactly as before.
     *
     * `.volatile()` is REQUIRED here, not cosmetic: the settings plane only
     * exposes a field that sits on or under a volatile node (`volatileForm()`
     * returns undefined otherwise, and `describe()` then skips this entry
     * entirely while `write()` throws). Verified against
     * `@deepseek-ai/dsh-settings`. Note that DSH 0.1.7-alpha.1 ships no client
     * that auto-generates a page from the schema, so this plugin also ships its
     * own settings card (see `src/client/`).
     */
    systemOne: z<Schemastery.ObjectS<NoInfer<{
        /** Master switch. Defaults to true; with no credential the gate stays a no-op. */
        enabled: z<boolean, boolean, "volatile-defined">;
        /** Endpoint accepting the System-one request contract. */
        endpoint: z<string, string, "volatile-defined">;
        /** Model identifier sent in the request body. */
        model: z<string, string, "volatile-defined">;
        /** Literal API key. Declared secret: redacted on every read, write-only in the form. */
        apiKey: z<string, string, "volatile">;
        /** Credential reference resolved through the credentials service, then the environment. */
        apiKeyEnv: z<string, string, "volatile-defined">;
        /** Question type used to judge each candidate. */
        mode: z<"noul" | "score", "noul" | "score", "volatile-defined">;
        /** noul mode: keep a candidate when its probability is at least this value. */
        threshold: z<number, number, "volatile-defined">;
        /** score mode: keep a candidate when its score is at least this value.
         * Jev's `score` is Σ(level_index × probability) over 0…levels−1, NOT 0–1;
         * with the default 5 levels the range is 0…4, where 2 = "partially relevant". */
        scoreMin: z<number, number, "volatile-defined">;
        /** Retain at least this many candidates when the model rejects an entire page. */
        minKeep: z<number, number, "volatile-defined">;
        /** Never judge more than this many candidates per request. */
        maxCandidates: z<number, number, "volatile-defined">;
        /** Truncate the task text to this many characters before sending it. */
        maxTaskChars: z<number, number, "volatile-defined">;
        /** End-to-end request deadline in milliseconds. */
        timeoutMs: z<number, number, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** Master switch. Defaults to true; with no credential the gate stays a no-op. */
        enabled: z<boolean, boolean, "volatile-defined">;
        /** Endpoint accepting the System-one request contract. */
        endpoint: z<string, string, "volatile-defined">;
        /** Model identifier sent in the request body. */
        model: z<string, string, "volatile-defined">;
        /** Literal API key. Declared secret: redacted on every read, write-only in the form. */
        apiKey: z<string, string, "volatile">;
        /** Credential reference resolved through the credentials service, then the environment. */
        apiKeyEnv: z<string, string, "volatile-defined">;
        /** Question type used to judge each candidate. */
        mode: z<"noul" | "score", "noul" | "score", "volatile-defined">;
        /** noul mode: keep a candidate when its probability is at least this value. */
        threshold: z<number, number, "volatile-defined">;
        /** score mode: keep a candidate when its score is at least this value.
         * Jev's `score` is Σ(level_index × probability) over 0…levels−1, NOT 0–1;
         * with the default 5 levels the range is 0…4, where 2 = "partially relevant". */
        scoreMin: z<number, number, "volatile-defined">;
        /** Retain at least this many candidates when the model rejects an entire page. */
        minKeep: z<number, number, "volatile-defined">;
        /** Never judge more than this many candidates per request. */
        maxCandidates: z<number, number, "volatile-defined">;
        /** Truncate the task text to this many characters before sending it. */
        maxTaskChars: z<number, number, "volatile-defined">;
        /** End-to-end request deadline in milliseconds. */
        timeoutMs: z<number, number, "volatile-defined">;
    }>>, "plain">;
}>>, "plain">;
/** Shape of the agent payload received by an `agent/created` listener. */
interface CreatedAgent {
    id: string;
    session?: {
        header?: {
            cwd?: string;
            delegationDepth?: number;
        };
    };
    ctx: {
        tools: {
            register(tool: unknown): unknown;
        };
        systemPrompt: {
            section(section: {
                name: string;
                order: number;
                text: string;
            }): unknown;
        };
    };
}
/**
 * Register the plugin: root-agent-scoped mem tools + workflow rules. No
 * global tool registration, no session-start seeding, no Git I/O at
 * registration time.
 */
declare function apply(ctx: {
    on(event: string, handler: (payload: {
        agent: CreatedAgent;
    }) => void): unknown;
    logger: {
        warn(message: string): void;
        info?(message: string): void;
    };
    /** Optional service accessor (credentials); absent in hand-built test contexts. */
    get?(name: string): unknown;
}, config?: Partial<{
    memDirName?: string;
    searchLimit?: number;
    branchAlign?: boolean;
    recentContextLimit?: number;
    lockTimeoutMs?: number;
    projectRoot?: string;
    /** System-one gate section; a live (`.volatile()`) node in the real loader. */
    systemOne?: unknown;
}>): Promise<void>;
export { Config, apply, inject, name };
