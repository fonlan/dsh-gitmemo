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
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string>;
}>, Schemastery.ObjectT<{
    /** Name of the memory repo directory at the project root. Default ".mem". */
    memDirName: z<string, string>;
    /** Max search hits per mem_search call. Default 20. */
    searchLimit: z<number, number>;
    /** Align the .mem branch with the project branch on writes. Default true. */
    branchAlign: z<boolean, boolean>;
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z<string, string>;
}>>;
interface ResolvedConfig {
    memDirName: string;
    searchLimit: number;
    branchAlign: boolean;
    projectRoot?: string;
}
interface RuntimeSkill {
    name: string;
    description: string;
    invocation?: {
        modelInvocable: boolean;
        userInvocable: boolean;
    };
    provider?: string;
    source?: string;
    content: string;
}
/**
 * Register the plugin: tools, skill, and prompt section.
 * @param ctx - registrant context carrying the host tool/skill/prompt services.
 * @param config - plugin configuration (defaults applied by the loader).
 */
declare function apply(ctx: {
    tools: {
        register(tool: unknown): unknown;
    };
    skills: {
        register(skill: RuntimeSkill): unknown;
    };
    systemPrompt: {
        section(section: {
            name: string;
            order: number;
            text: string;
        }): unknown;
    };
    logger: {
        warn(message: string): void;
    };
}, config?: Partial<ResolvedConfig>): Promise<void>;
export { Config, apply, inject, name };
