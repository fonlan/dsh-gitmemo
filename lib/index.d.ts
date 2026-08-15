/**
 * dsh-gitmemo — Git-backed long-term memory for DeepSeek Harness.
 *
 * A Cordis plugin mirroring gitmemo (https://github.com/fonlan/gitmemo):
 * the agent stores completed task outcomes as markdown entries in a local
 * `.mem` git repository and searches them before starting new work.
 *
 * This plugin registers on the host plane:
 *  - five model-facing tools: `mem_init`, `mem_search`, `mem_read`,
 *    `mem_write`, `mem_delete` (backed by {@link GitMemo});
 *  - an always-on system-prompt section with the full memory workflow rules;
 *  - a per-session seed of the most recent memory titles.
 *
 * @module dsh-gitmemo
 */
import z from "@deepseek-ai/schemastery";
/** Cordis plugin name. */
declare const name = "dsh-gitmemo";
/** Host services this plugin needs. */
declare const inject: string[];
/** Plugin configuration (all optional). */
declare const Config: z<Schemastery.ObjectS<{
    /** Name of the memory repo directory at the project root. Default ".mem". */
    memDirName: z<string, string>;
    /** Max search hits per mem_search call. Default 20. */
    searchLimit: z<number, number>;
    /** Align the .mem branch with the project branch on writes. Default true. */
    branchAlign: z<boolean, boolean>;
    /** Number of most recent memory titles injected into each new session's system prompt (0 disables). Default 5. */
    recentContextLimit: z<number, number>;
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string>;
}>, Schemastery.ObjectT<{
    /** Name of the memory repo directory at the project root. Default ".mem". */
    memDirName: z<string, string>;
    /** Max search hits per mem_search call. Default 20. */
    searchLimit: z<number, number>;
    /** Align the .mem branch with the project branch on writes. Default true. */
    branchAlign: z<boolean, boolean>;
    /** Number of most recent memory titles injected into each new session's system prompt (0 disables). Default 5. */
    recentContextLimit: z<number, number>;
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string>;
}>>;
interface ResolvedConfig {
    memDirName: string;
    searchLimit: number;
    branchAlign: boolean;
    recentContextLimit: number;
    projectRoot?: string;
}
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
        systemPrompt: {
            context(section: {
                name: string;
                order: number;
                text: string;
            }): unknown;
        };
    };
}
/**
 * Register the plugin: tools, always-on rules, and session-start seed.
 * @param ctx - registrant context carrying the host tool/prompt services.
 * @param config - plugin configuration (defaults applied by the loader).
 */
declare function apply(ctx: {
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
    on(event: string, handler: (payload: {
        agent: CreatedAgent;
    }) => void): unknown;
    logger: {
        warn(message: string): void;
    };
}, config?: Partial<ResolvedConfig>): Promise<void>;
export { Config, apply, inject, name };
