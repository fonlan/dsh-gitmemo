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
import { defineTool } from "@deepseek-ai/dsh-tools";
import { GitMemo, type GitMemoConfig } from "./mem.js";

/** Cordis plugin name. */
const name = "dsh-gitmemo";

/** Host services this plugin needs. */
const inject = ["tools", "systemPrompt"];

/** Plugin configuration (all optional). */
const Config = z.object({
  /** Name of the memory repo directory at the project root. Default ".mem". */
  memDirName: z.string().default(".mem"),
  /** Max search hits per mem_search call. Default 20. */
  searchLimit: z.number().default(20),
  /** Align the .mem branch with the project branch on writes. Default true. */
  branchAlign: z.boolean().default(true),
  /** Number of most recent memory titles injected into each new session's system prompt (0 disables). Default 5. */
  recentContextLimit: z.number().default(5),
  /** Optional explicit project root; defaults to the calling session's cwd. */
  projectRoot: z.string()
});

interface ResolvedConfig {
  memDirName: string;
  searchLimit: number;
  branchAlign: boolean;
  recentContextLimit: number;
  projectRoot?: string;
}

/** The calling agent's session workspace, when it has one. */
function sessionCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session?.header?.cwd;
}

/** Build the engine for one tool call. */
function engineFor(exec: unknown, config: ResolvedConfig): GitMemo {
  const cwd = sessionCwd(exec as { agent?: { session?: { header?: { cwd?: string } } } }) ?? process.cwd();
  const root = config.projectRoot ?? cwd;
  const engineConfig: GitMemoConfig = {
    memDirName: config.memDirName,
    searchLimit: config.searchLimit,
    branchAlign: config.branchAlign
  };
  return new GitMemo(root, engineConfig);
}

const SEARCH_HIT = {
  type: "object",
  additionalProperties: false,
  properties: {
    hash: { type: "string", required: true, description: "Full commit hash of the memory entry." },
    title: { type: "string", required: true, description: "Commit subject (the entry title)." },
    date: { type: "string", required: true, description: "Commit date in ISO format." }
  }
} as const;

/** Render one tool output block as plain text. */
function textBlock(text: string) {
  return [{ type: "text" as const, text }];
}

/** Register every model-facing tool. */
function registerMemTools(ctx: { tools: { register(tool: unknown): unknown } }, config: ResolvedConfig): void {
  void config;

  ctx.tools.register(defineTool({
    name: "mem_init",
    description:
      "Initialize the gitmemo long-term memory repository (.mem git repo) at the project root. All other mem_* tools auto-initialize, so this is only needed to check or force initialization.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true, description: "Absolute path of the memory repository." }
        }
      },
      render: (_args: unknown, value: { path: string }) => textBlock("OK: Memory repo ready at " + value.path)
    },
    isConcurrencySafe: () => false,
    async execute(_args: unknown, exec: unknown) {
      const memo = engineFor(exec, config);
      const path = await memo.init();
      return { path };
    },
    presentCall: () => ({ card: "generic", title: "Init gitmemo memory", kind: "other" })
  }));

  ctx.tools.register(defineTool({
    name: "mem_search",
    description:
      "Search the gitmemo long-term memory (.mem git repo) for past task outcomes. Call BEFORE starting work: extract 3-5 keywords from the user request, search, and reuse prior conclusions when relevant. Returns up to 20 hits formatted as `hash|title|date`; when nothing relevant appears, paginate with `skip` 20, 40, ...",
    parameters: {
      keywords: {
        type: "string",
        required: true,
        description: "Comma-separated keywords (3-5 recommended), e.g. \"auth,rate-limit,login\"."
      },
      skip: {
        type: "integer",
        description: "Pagination offset (default 0)."
      },
      mode: {
        type: "string",
        enum: ["and", "or", "auto"],
        description: "and=strict (all keywords), or=broad (any keyword), auto=AND first then OR fallback (default auto)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true, description: "The mode actually used (and or or)." },
          results: { type: "array", required: true, items: SEARCH_HIT }
        }
      },
      render: (_args: unknown, value: { mode: string; results: Array<{ hash: string; title: string; date: string }> }) => {
        const lines = value.results.map((hit) => hit.hash + "|" + hit.title + "|" + hit.date);
        return textBlock(lines.length > 0 ? lines.join("\n") : "(no matching memories)");
      }
    },
    isConcurrencySafe: () => true,
    async execute(args: { keywords: string; skip?: number; mode?: string }, exec: unknown) {
      const memo = engineFor(exec, config);
      return await memo.search(args.keywords, args.skip ?? 0, (args.mode as "and" | "or" | "auto") ?? "auto");
    },
    presentCall: (args: { keywords: string }) => ({
      card: "generic",
      title: "Search memory: " + args.keywords,
      kind: "other"
    })
  }));

  ctx.tools.register(defineTool({
    name: "mem_read",
    description:
      "Read one gitmemo memory entry by commit hash (returned by mem_search). Select only the most relevant memories before reading — at most 5 when a search returns more.",
    parameters: {
      commit_hash: {
        type: "string",
        required: true,
        description: "Commit hash of the memory entry to read."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          commit_hash: { type: "string", required: true },
          file: { type: "string", required: true, description: "Entry file path inside the memory repo." },
          content: { type: "string", required: true, description: "Full markdown of the memory entry." }
        }
      },
      render: (_args: unknown, value: { commit_hash: string; file: string; content: string }) =>
        textBlock(value.content)
    },
    isConcurrencySafe: () => true,
    async execute(args: { commit_hash: string }, exec: unknown) {
      const memo = engineFor(exec, config);
      const { file, content } = await memo.read(args.commit_hash);
      return { commit_hash: args.commit_hash, file, content };
    },
    presentCall: (args: { commit_hash: string }) => ({
      card: "generic",
      title: "Read memory " + args.commit_hash.slice(0, 8),
      kind: "read"
    })
  }));

  ctx.tools.register(defineTool({
    name: "mem_write",
    description:
      "Store a completed task outcome in the gitmemo long-term memory (.mem git repo). Write ONLY when the task is complete AND repo-related AND the outcome is valuable/reusable OR the user explicitly asked to remember. Entry markdown goes through `content` (or `content_file`); `title` is a short \"[module] action + object\"; `body` is an optional 1-3 sentence commit body (never memory content). The entry is committed as `.mem/entries/<timestamp>-<slug>.md` and the .mem branch follows the project branch.",
    parameters: {
      title: {
        type: "string",
        required: true,
        description: "Short \"[module] action + object\" title, e.g. \"[auth] add rate-limit for login\"."
      },
      content: {
        type: "string",
        description: "The memory entry markdown (YAML front matter + sections). Provide exactly one of content / content_file / file."
      },
      content_file: {
        type: "string",
        description: "Path to a file holding the entry markdown (alternative to content; temp files are deleted after a successful write)."
      },
      file: {
        type: "string",
        description: "An existing .mem/entries/... path to commit in place (alternative to content / content_file)."
      },
      body: {
        type: "string",
        description: "Optional commit body: 1-3 sentence summary + metadata. Not memory content."
      },
      body_file: {
        type: "string",
        description: "Path to a file holding the commit body (alternative to body)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hash: { type: "string", required: true, description: "Commit hash of the new memory entry." },
          file: { type: "string", required: true, description: "Entry file path inside the memory repo." }
        }
      },
      render: (_args: unknown, value: { hash: string; file: string }) =>
        textBlock("OK: " + value.hash + "|" + value.file)
    },
    isConcurrencySafe: () => false,
    async execute(
      args: { title: string; content?: string; content_file?: string; file?: string; body?: string; body_file?: string },
      exec: unknown
    ) {
      const memo = engineFor(exec, config);
      return await memo.write({
        title: args.title,
        content: args.content,
        contentFile: args.content_file,
        file: args.file,
        body: args.body,
        bodyFile: args.body_file
      });
    },
    presentCall: (args: { title: string }) => ({
      card: "generic",
      title: "Write memory: " + args.title,
      kind: "other"
    })
  }));

  ctx.tools.register(defineTool({
    name: "mem_delete",
    description:
      "Delete a gitmemo memory entry by commit hash. Use when the user is unsatisfied with a stored outcome: delete, redo the task from feedback, then mem_write a corrected entry.",
    parameters: {
      commit_hash: {
        type: "string",
        required: true,
        description: "Commit hash of the memory entry to delete."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", required: true, description: "Deleted entry file path." }
        }
      },
      render: (_args: unknown, value: { file: string }) => textBlock("OK: deleted " + value.file)
    },
    isConcurrencySafe: () => false,
    async execute(args: { commit_hash: string }, exec: unknown) {
      const memo = engineFor(exec, config);
      const file = await memo.delete(args.commit_hash);
      return { file };
    },
    presentCall: (args: { commit_hash: string }) => ({
      card: "generic",
      title: "Delete memory " + args.commit_hash.slice(0, 8),
      kind: "other"
    })
  }));
}

/**
 * Register the always-on memory workflow rules (the equivalent of gitmemo's
 * agents-template.md). This section is part of every session's system prompt,
 * so the rules cannot be missed; the mem_* tool descriptions carry the
 * argument contract for each operation.
 */
function registerPromptSection(ctx: { systemPrompt: { section(section: { name: string; order: number; text: string }): unknown } }): void {
  ctx.systemPrompt.section({
    name: "memory:gitmemo",
    order: 150,
    text: [
      "This deployment provides gitmemo long-term memory: a local .mem git repository at the project root stores past task outcomes as markdown entries; git is the only dependency. Use the dedicated tools only (mem_search / mem_read / mem_write / mem_delete — all auto-initialize); never shell out to git or read .mem files directly.",
      "- BEFORE WORK — search: extract 3-5 keywords from the user request and run mem_search. If more than 5 relevant hits appear, select only the 5 most likely (keyword overlap, title specificity, recency) and mem_read only those; reuse their conclusions when appropriate. If nothing relevant, paginate with skip 20, 40, ...",
      "- USER UNSATISFIED — delete and rewrite: mem_delete the entry's commit hash, redo the task from the feedback, then mem_write a corrected entry.",
      "- END-OF-SESSION CHECKPOINT — the ONLY write path: when the conversation is ending, review the whole session and mem_write EVERY completed repo-related task that still lacks a memory and whose outcome is valuable and reusable OR was explicitly asked to be remembered. Never write for pure Q&A, incomplete tasks, non-repo work, or purely operational git actions (commit/push only). Never duplicate an already-written entry; if a stored outcome is outdated, mem_delete it first, then write the corrected entry. Entry title: \"[module] action + object\"; content: markdown with YAML front matter (date, status, repo_branch, mem_branch, related_paths, tags) and Original User Request / AI Understanding / Final Outcome sections."
    ].join("\n")
  });
}

/** Shape of the agent payload received by an `agent/created` listener. */
interface CreatedAgent {
  id: string;
  session?: { header?: { cwd?: string; delegationDepth?: number } };
  ctx: {
    systemPrompt: { context(section: { name: string; order: number; text: string }): unknown };
  };
}

/**
 * Seed every new ROOT agent session with the most recent memory titles.
 * Registered into the agent's own scope, so the block joins only that
 * session's prompt; subagents (delegationDepth > 0) are skipped, the lookup
 * is read-only (no .mem auto-init), and failures degrade to a log warning.
 */
function registerRecentContext(
  ctx: { on(event: string, handler: (payload: { agent: CreatedAgent }) => void): unknown; logger: { warn(message: string): void } },
  config: ResolvedConfig
): void {
  if (config.recentContextLimit <= 0) return;
  ctx.on("agent/created", ({ agent }) => {
    const header = agent.session?.header;
    if (header?.cwd === undefined || (header.delegationDepth ?? 0) > 0) return;
    try {
      // Synchronous scan: registers the context before the first request assembles.
      const memo = new GitMemo(config.projectRoot ?? header.cwd, {
        memDirName: config.memDirName,
        searchLimit: config.searchLimit,
        branchAlign: config.branchAlign
      });
      const hits = memo.recentSync(config.recentContextLimit);
      if (hits.length === 0) return;
      const lines = hits.map((hit) => hit.hash + "|" + hit.title + "|" + hit.date);
      agent.ctx.systemPrompt.context({
        name: "memory:gitmemo-recent",
        order: 400,
        text: "Recent gitmemo memories from previous sessions (mem_read <hash> for details, mem_search for targeted lookups):\n" + lines.join("\n")
      });
    } catch (error) {
      ctx.logger.warn(`dsh-gitmemo: recent-memory injection skipped for agent "${agent.id}": ${String(error)}`);
    }
  });
}

/**
 * Register the plugin: tools, always-on rules, and session-start seed.
 * @param ctx - registrant context carrying the host tool/prompt services.
 * @param config - plugin configuration (defaults applied by the loader).
 */
async function apply(ctx: {
  tools: { register(tool: unknown): unknown };
  systemPrompt: { section(section: { name: string; order: number; text: string }): unknown };
  on(event: string, handler: (payload: { agent: CreatedAgent }) => void): unknown;
  logger: { warn(message: string): void };
}, config: Partial<ResolvedConfig> = {}): Promise<void> {
  const resolved: ResolvedConfig = {
    memDirName: config.memDirName ?? ".mem",
    searchLimit: config.searchLimit ?? 20,
    branchAlign: config.branchAlign ?? true,
    recentContextLimit: config.recentContextLimit ?? 5,
    projectRoot: config.projectRoot
  };
  registerMemTools(ctx, resolved);
  registerPromptSection(ctx);
  registerRecentContext(ctx, resolved);
}

export { Config, apply, inject, name };
