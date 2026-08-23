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
declare const Config: z<Schemastery.ObjectS<{
    /** @deprecated — the memory dir is fixed at `<projectRoot>/.mem`; kept for one version. */
    memDirName: z<string, string>;
    /** Max search hits per mem_search call (page size). Default 20. */
    searchLimit: z<number, number>;
    /** @deprecated — `.mem` always stays on main; kept for one version, no effect. */
    branchAlign: z<boolean, boolean>;
    /** @deprecated — session-start recent seeding was removed; kept for one version, no effect. */
    recentContextLimit: z<number, number>;
    /** Cross-process lock wait timeout in milliseconds. Default 30000. */
    lockTimeoutMs: z<number, number>;
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string>;
}>, Schemastery.ObjectT<{
    /** @deprecated — the memory dir is fixed at `<projectRoot>/.mem`; kept for one version. */
    memDirName: z<string, string>;
    /** Max search hits per mem_search call (page size). Default 20. */
    searchLimit: z<number, number>;
    /** @deprecated — `.mem` always stays on main; kept for one version, no effect. */
    branchAlign: z<boolean, boolean>;
    /** @deprecated — session-start recent seeding was removed; kept for one version, no effect. */
    recentContextLimit: z<number, number>;
    /** Cross-process lock wait timeout in milliseconds. Default 30000. */
    lockTimeoutMs: z<number, number>;
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string>;
}>>;
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
    };
}, config?: Partial<{
    memDirName?: string;
    searchLimit?: number;
    branchAlign?: boolean;
    recentContextLimit?: number;
    lockTimeoutMs?: number;
    projectRoot?: string;
}>): Promise<void>;
export { Config, apply, inject, name };
