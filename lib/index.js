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
import { defineTool } from "@deepseek-ai/dsh-tools";
import { GitMemo, GitMemoError, resolveProjectRoot } from "./mem.js";
/** Cordis plugin name. */
const name = "dsh-gitmemo";
/** Host services this plugin needs. */
const inject = ["tools", "systemPrompt"];
/** Plugin configuration. */
const Config = z.object({
    /** @deprecated — the memory dir is fixed at `<projectRoot>/.mem`; kept for one version. */
    memDirName: z.string().default(".mem"),
    /** Max search hits per mem_search call (page size). Default 20. */
    searchLimit: z.number().default(20),
    /** @deprecated — `.mem` always stays on main; kept for one version, no effect. */
    branchAlign: z.boolean().default(true),
    /** @deprecated — session-start recent seeding was removed; kept for one version, no effect. */
    recentContextLimit: z.number().default(5),
    /** Cross-process lock wait timeout in milliseconds. Default 30000. */
    lockTimeoutMs: z.number().default(30000),
    /** Optional explicit project root; defaults to the calling session's cwd. */
    projectRoot: z.string()
});
/** The calling agent's session workspace, when it has one. */
function sessionCwd(exec) {
    return exec.agent?.session?.header?.cwd;
}
/** Build the engine for one tool call (project root per plan 3.1). */
async function engineFor(exec, config) {
    const cwd = sessionCwd(exec) ?? process.cwd();
    const root = config.projectRoot ?? (await resolveProjectRoot(cwd));
    const engineConfig = {
        searchLimit: config.searchLimit,
        lockTimeoutMs: config.lockTimeoutMs
    };
    return new GitMemo(root, engineConfig);
}
const SEARCH_HIT = {
    type: "object",
    additionalProperties: false,
    properties: {
        hash: { type: "string", required: true, description: "Full commit hash of the memory entry." },
        title: { type: "string", required: true, description: "Entry title (commit subject)." },
        date: { type: "string", required: true, description: "Commit date in ISO format." },
        summary: { type: "string", required: true, description: "Entry summary (from the commit body)." },
        keywords: {
            type: "array",
            required: true,
            items: { type: "string" },
            description: "Structured keywords stored with the entry."
        },
        kind: {
            type: "string",
            required: true,
            description: "Entry kind: task (task-outcome record) or topic (aggregated topic page)."
        },
        score: {
            type: "number",
            required: true,
            description: "Relevance: distinct matched keywords + a mild recency bonus (≤ +0.5, decaying to 0 by ~180 days)."
        },
        matched_keywords: {
            type: "array",
            required: true,
            items: { type: "string" },
            description: "The query keywords that actually matched this entry."
        }
    }
};
const LINK_RESOLUTION = {
    type: "object",
    additionalProperties: false,
    properties: {
        link_hash: { type: "string", required: true, description: "Hash exactly as written inside the [[...]] link." },
        resolved_hash: {
            type: "string",
            required: true,
            description: "Hash actually read: the active version of the linked entry (empty string when unresolvable)."
        },
        active: {
            type: "boolean",
            required: true,
            description: "True when the link still points at the active version; false = superseded or dangling."
        },
        file: { type: "string", description: "Entry file path inside the memory repo." },
        title: { type: "string", description: "Target entry title." },
        summary: { type: "string", description: "Target entry summary." },
        keywords: { type: "array", items: { type: "string" }, description: "Target entry keywords." },
        kind: { type: "string", description: "Target entry kind: task or topic." },
        error: { type: "string", description: "Present when the link target could not be resolved (dangling link)." }
    }
};
const KEYWORDS_ARRAY = {
    type: "array",
    items: { type: "string" },
    description: "1-12 keywords (include 中英文 synonyms when useful)."
};
const RELATED_BRANCHES = {
    type: "array",
    items: { type: "string" },
    description: "Related code branches (max 32; the current branch is always recorded)."
};
const RELATED_PATHS = {
    type: "array",
    items: { type: "string" },
    description: "Project-relative paths (max 128; absolute paths and escaping paths are rejected)."
};
/** Render one tool output block as plain text. */
function textBlock(text) {
    return [{ type: "text", text }];
}
function formatSearchResults(value) {
    const lines = [
        `snapshot=${value.snapshot} total=${value.total} next_skip=${value.next_skip ?? "null"}` +
            (value.legacy === true ? " legacy=true" : "")
    ];
    for (const hit of value.results) {
        lines.push(hit.hash +
            "|" +
            hit.title +
            "|" +
            hit.date +
            "|kind=" +
            hit.kind +
            "|score=" +
            hit.score +
            "|matched=" +
            hit.matched_keywords.join(","));
        if (hit.summary.length > 0)
            lines.push("  summary: " + hit.summary.replace(/\s+/g, " ").slice(0, 300));
    }
    if (value.results.length === 0)
        lines.push("(no matching memories)");
    if (value.warning !== undefined)
        lines.push("warning: " + value.warning);
    for (const diagnostic of value.diagnostics ?? [])
        lines.push("diagnostic: " + diagnostic);
    return lines.join("\n");
}
/** Register the five model-facing tools into a scoped agent context. */
function registerMemTools(ctx, config) {
    ctx.tools.register(defineTool({
        name: "mem_search",
        description: "Search the gitmemo long-term memory (.mem git repo) for past task outcomes. Call BEFORE starting repo-related work: extract 1-12 中英文关键词 from the user request (include synonyms in both languages when useful) and run mem_search; pure chat and general Q&A need no search. Returns a snapshot, total, next_skip and up to 20 scored hits with summary/keywords/kind/matched_keywords — score = distinct matched keywords + a mild recency bonus, so newer entries rank slightly higher and superseded conclusions lose to their replacements. Select at most 5 most relevant hits and mem_read them (prefer kind:\"topic\" hits as topic-page entry points). Paginate by passing skip and the returned snapshot back unchanged; a stale snapshot is rejected explicitly.",
        parameters: {
            keywords: { ...KEYWORDS_ARRAY, required: true },
            skip: {
                type: "integer",
                description: "Pagination offset (default 0)."
            },
            snapshot: {
                type: "string",
                description: "Snapshot returned by the first page — pass it back unchanged for stable pagination."
            }
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    snapshot: { type: "string", required: true, description: "Stable search snapshot; reuse for pagination." },
                    total: { type: "number", required: true, description: "Total matching results in the snapshot." },
                    next_skip: {
                        oneOf: [{ type: "number" }, { type: "null" }],
                        required: true,
                        description: "Offset for the next page, or null."
                    },
                    results: { type: "array", required: true, items: SEARCH_HIT },
                    legacy: { type: "boolean", description: "True when searching a legacy (pre-migration) repo read-only." },
                    warning: { type: "string", description: "Compatibility/deprecation warning, when present." },
                    diagnostics: {
                        type: "array",
                        items: { type: "string" },
                        description: "Malformed commit/file mappings skipped during search."
                    }
                }
            },
            render: (_args, value) => textBlock(formatSearchResults(value))
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const memo = await engineFor(exec, config);
            return await memo.search(args.keywords, {
                skip: args.skip ?? 0,
                snapshot: args.snapshot,
                mode: args.mode
            });
        },
        presentCall: (args) => ({
            card: "generic",
            title: "Search memory: " + (Array.isArray(args.keywords) ? args.keywords.join(", ") : args.keywords),
            kind: "other"
        })
    }));
    ctx.tools.register(defineTool({
        name: "mem_read",
        description: "Read one gitmemo memory entry by commit hash (returned by mem_search). Select only the most relevant memories before reading — at most 5 when a search returns more. Historical entries that were replaced or deleted stay readable for audit. Pass expand:true to also resolve [[<commit-hash>]] wiki links in the entry body one hop to their target entries (each target follows forward to its active version) — use it when reading a kind:\"topic\" topic page or any entry that links others.",
        parameters: {
            commit_hash: {
                type: "string",
                required: true,
                description: "Commit hash of the memory entry to read (create or replace hash)."
            },
            expand: {
                type: "boolean",
                description: "Resolve [[<commit-hash>]] links in the entry body one hop to their (active) target entries. Default false."
            }
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    commit_hash: { type: "string", required: true },
                    file: { type: "string", required: true, description: "Entry file path inside the memory repo." },
                    content: { type: "string", required: true, description: "Full markdown of the memory entry." },
                    kind: {
                        type: "string",
                        required: true,
                        description: "Entry kind: task (task-outcome record) or topic (aggregated topic page)."
                    },
                    links: {
                        type: "array",
                        items: LINK_RESOLUTION,
                        description: "One-hop resolution of the entry's [[<commit-hash>]] links; present only when expand:true."
                    },
                    legacy: { type: "boolean", description: "True for legacy-format commits (pre-migration)." }
                }
            },
            render: (_args, value) => {
                const parts = [(value.legacy === true ? "[legacy entry]\n" : "") + value.content];
                if (value.links !== undefined && value.links.length > 0) {
                    parts.push("--- linked entries (" + value.links.length + ") ---");
                    for (const link of value.links) {
                        if (link.error !== undefined) {
                            parts.push("x " + link.link_hash.slice(0, 8) + " — unresolved: " + link.error);
                            continue;
                        }
                        const state = link.active
                            ? "active"
                            : link.resolved_hash !== link.link_hash
                                ? "superseded → " + link.resolved_hash.slice(0, 8)
                                : "not active (withdrawn)";
                        parts.push("= " + link.resolved_hash.slice(0, 8) + " [" + (link.kind ?? "task") + "] " +
                            (link.title ?? "") + " (" + state + ")");
                        if (link.summary !== undefined && link.summary.length > 0) {
                            parts.push("  " + link.summary.replace(/\s+/g, " ").slice(0, 400));
                        }
                    }
                }
                return textBlock(parts.join("\n"));
            }
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const memo = await engineFor(exec, config);
            const { hash, file, content, kind, links, legacy } = await memo.read(args.commit_hash, {
                expand: args.expand === true
            });
            return {
                commit_hash: hash,
                file,
                content,
                kind,
                ...(links !== undefined ? { links } : {}),
                ...(legacy ? { legacy: true } : {})
            };
        },
        presentCall: (args) => ({
            card: "generic",
            title: "Read memory " + args.commit_hash.slice(0, 8),
            kind: "read"
        })
    }));
    ctx.tools.register(defineTool({
        name: "mem_write",
        description: "Store a completed task outcome in the gitmemo long-term memory (.mem git repo). Write ONLY when the task is complete AND repo-related AND the outcome is valuable/reusable OR the user explicitly asked to remember. Entries are immutable: title (single line, ≤200 chars, \"[module] action + object\"), summary (≤4000 chars), keywords (2-12, include 中英文同义词) and content (markdown body; the engine generates front matter) are all required; related_branches/related_paths are optional. kind selects the entry type: \"task\" (default) is a task-outcome record; \"topic\" is an aggregated topic page (MOC) — its summary states the currently-valid conclusions and its content links evidence entries as [[<commit-hash>]] with a one-line status each; a topic page evolves via mem_replace, not per-task rewrites. Keywords must ADD new search angles — pick task-related terms (中英文同义词 both fine) that are NOT already present in title/summary: words already in title/summary are searchable via those fields themselves, so repeating them does not improve recall. Corrections and superseded conclusions use mem_replace, withdrawal uses mem_delete — never rewrite in place.",
        parameters: {
            title: {
                type: "string",
                required: true,
                description: "Short \"[module] action + object\" title, single line, e.g. \"[auth] add rate-limit for login\"."
            },
            summary: {
                type: "string",
                required: true,
                description: "1-3 sentence summary of the outcome (multi-line allowed, ≤4000 chars)."
            },
            keywords: {
                ...KEYWORDS_ARRAY,
                required: true,
                description: "2-12 keywords (1-64 chars each); task-related words NOT already present in title/summary (重复 title/summary 已有的词不会提高召回率); include 中英文同义词, e.g. [\"auth\", \"rate-limit\", \"登录\", \"限流\"]."
            },
            content: {
                type: "string",
                required: true,
                description: "The memory markdown body (engine generates front matter and standard sections). Reference other entries as [[<commit-hash>]]."
            },
            kind: {
                type: "string",
                description: "Entry kind: \"task\" (default) or \"topic\" (aggregated topic page linking evidence entries via [[<commit-hash>]])."
            },
            related_branches: RELATED_BRANCHES,
            related_paths: RELATED_PATHS
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    hash: { type: "string", required: true, description: "Commit hash of the new memory entry." },
                    file: { type: "string", required: true, description: "Entry file path inside the memory repo." },
                    legacy: { type: "boolean", description: "True when written through the legacy compatibility adapter." }
                }
            },
            render: (_args, value) => textBlock("OK: " + value.hash + "|" + value.file + (value.legacy === true ? " (legacy adapter)" : ""))
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const memo = await engineFor(exec, config);
            if (args.file !== undefined) {
                throw new GitMemoError("gitmemo: mem_write `file` (in-place commit) is not supported by the immutable entry model — pass content directly, or use mem_replace to update an entry");
            }
            return await memo.write({
                title: args.title,
                summary: args.summary ?? "",
                keywords: args.keywords ?? [],
                content: args.content ?? "",
                related_branches: args.related_branches,
                related_paths: args.related_paths,
                kind: args.kind
            });
        },
        presentCall: (args) => ({
            card: "generic",
            title: "Write memory: " + args.title,
            kind: "other"
        })
    }));
    ctx.tools.register(defineTool({
        name: "mem_delete",
        description: "Withdraw a gitmemo memory entry whose conclusion is obsolete and has NO replacement. Requires the active commit hash (returned by mem_search) and a required reason. Use mem_replace when a new conclusion replaces the old one.",
        parameters: {
            commit_hash: {
                type: "string",
                required: true,
                description: "Active commit hash of the memory entry to withdraw."
            },
            reason: {
                type: "string",
                required: true,
                description: "Why the conclusion is withdrawn (recorded in the delete commit)."
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
            render: (_args, value) => textBlock("OK: deleted " + value.file)
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const memo = await engineFor(exec, config);
            const { file } = await memo.delete({ commit_hash: args.commit_hash, reason: args.reason });
            return { file };
        },
        presentCall: (args) => ({
            card: "generic",
            title: "Delete memory " + args.commit_hash.slice(0, 8),
            kind: "other"
        })
    }));
    ctx.tools.register(defineTool({
        name: "mem_replace",
        description: "Replace an active gitmemo memory entry with a new conclusion in ONE atomic commit (deletes the old entry file, adds the new one). Use it whenever a stored conclusion is superseded — the user corrects a stored outcome, OR this session's own work overrules it (implemented/refactored away) — never delete-then-write. commit_hash must be the ACTIVE hash returned by mem_search; stale hashes are rejected. Takes the same fields as mem_write; kind defaults to the replaced entry's kind (refreshing a topic page stays a topic page).",
        parameters: {
            commit_hash: {
                type: "string",
                required: true,
                description: "Active commit hash of the entry to replace."
            },
            title: {
                type: "string",
                required: true,
                description: "Short \"[module] action + object\" title, single line."
            },
            summary: {
                type: "string",
                required: true,
                description: "1-3 sentence summary of the new conclusion."
            },
            keywords: {
                ...KEYWORDS_ARRAY,
                required: true,
                description: "2-12 keywords (1-64 chars each); task-related words NOT already present in title/summary; include 中英文同义词."
            },
            content: {
                type: "string",
                required: true,
                description: "The new memory markdown body. Keep [[<commit-hash>]] links to evidence entries up to date."
            },
            kind: {
                type: "string",
                description: "Entry kind: \"task\" or \"topic\". Defaults to the replaced entry's kind when omitted."
            },
            related_branches: RELATED_BRANCHES,
            related_paths: RELATED_PATHS
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    hash: { type: "string", required: true, description: "Commit hash of the replace commit." },
                    file: { type: "string", required: true, description: "New entry file path inside the memory repo." }
                }
            },
            render: (_args, value) => textBlock("OK: " + value.hash + "|" + value.file)
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const memo = await engineFor(exec, config);
            return await memo.replace({
                commit_hash: args.commit_hash,
                title: args.title,
                summary: args.summary ?? "",
                keywords: args.keywords ?? [],
                content: args.content ?? "",
                related_branches: args.related_branches,
                related_paths: args.related_paths,
                kind: args.kind
            });
        },
        presentCall: (args) => ({
            card: "generic",
            title: "Replace memory " + args.commit_hash.slice(0, 8) + ": " + args.title,
            kind: "other"
        })
    }));
}
/**
 * Register the gitmemo workflow rules (plan 9.2) into a scoped agent context.
 */
function registerPromptSection(ctx) {
    ctx.systemPrompt.section({
        name: "memory:gitmemo",
        order: 150,
        text: [
            "This deployment provides gitmemo long-term memory: a local .mem git repository at the project root stores past task outcomes as immutable markdown entries; git is the only dependency. Use the dedicated tools only (mem_search / mem_read / mem_write / mem_delete / mem_replace — all auto-initialize, and legacy-format .mem repos migrate automatically on first use); never shell out to git or read .mem files directly.",
            "- BEFORE WORK — search: 仓库相关任务开始前提取 1–12 个中英文关键词调用 mem_search（含中英文同义词）；纯闲聊和通用问答无需搜索。",
            "- RESULT PRESELECT — 根据 title、summary、keywords、score 和 matched keywords 选择最多 5 条执行 mem_read，复用相关结论；kind 为 topic 的条目是该主题的聚合入口，优先读；无相关结果时用返回的 snapshot + skip 翻页。",
            "- END-OF-SESSION CHECKPOINT — the ONLY write path: 会话结束时回顾全程，仅当结论有价值、可复用或用户明确要求记住时 mem_write；纯问答、未完成任务、非仓库工作、纯操作类 git 动作（仅 commit/push）不写；避免语义重复。",
            "- KEYWORD SELECTION — mem_write/mem_replace 的 keywords 应选择与任务相关但未出现在 title/summary 中的词（中英文同义词皆可）；title/summary 里已有的词本身就能被检索到，重复它们不会提高召回率。",
            "- KEEP FRESH — 结论保鲜是写路径的一部分，不必等用户指出：用户更正旧结论时，有替代结论用 mem_replace（禁止先 delete 再 write），作废且无替代用带 reason 的 mem_delete；本次会话的工作覆盖/推翻了某条已存结论（被后续实现、重构取代）时，同样主动 mem_replace 或 mem_delete 对应旧条目；检索结果中新旧结论冲突时，优先采信 score 更高/日期更新的条目（score 已含温和的 recency 加成）。",
            "- TOPIC PAGE — 同一主题已积累多条记忆、或需要一个「当前真相」入口时，用 mem_write 写一条 kind:\"topic\" 聚合条目：summary 概括当下仍然有效的结论，content 用 [[<commit-hash>]] 链接各证据条目并各配一句话状态；topic 条目靠 mem_replace 演进（kind 自动继承），不是按任务新增。",
            "- WIKI LINKS — content 中引用其他记忆条目一律写 [[<commit-hash>]]（用 mem_search/mem_read 返回的 hash）；mem_read 传 expand:true 会把链接一跳展开到各条目的最新版本（悬空链接以 error 返回），读 topic 条目时建议展开。",
            "- SUBAGENT RESULTS — 子代理结果由根 Agent 汇总后决定是否形成一条会话级记忆。"
        ].join("\n")
    });
}
/**
 * Register the plugin: root-agent-scoped mem tools + workflow rules. No
 * global tool registration, no session-start seeding, no Git I/O at
 * registration time.
 */
async function apply(ctx, config = {}) {
    const resolved = {
        searchLimit: config.searchLimit ?? 20,
        lockTimeoutMs: config.lockTimeoutMs ?? 30000,
        projectRoot: config.projectRoot
    };
    if (config.branchAlign !== undefined && config.branchAlign !== true) {
        ctx.logger.warn("dsh-gitmemo: `branchAlign` is deprecated and has no effect — .mem always stays on main");
    }
    if (config.recentContextLimit !== undefined && config.recentContextLimit !== 5) {
        ctx.logger.warn("dsh-gitmemo: `recentContextLimit` is deprecated and has no effect — session-start recent seeding was removed");
    }
    if (config.memDirName !== undefined && config.memDirName !== ".mem") {
        ctx.logger.warn("dsh-gitmemo: `memDirName` is deprecated — the memory directory is fixed at <projectRoot>/.mem; pass a legacy dir as the migration --source");
    }
    ctx.on("agent/created", ({ agent }) => {
        const header = agent.session?.header;
        if ((header?.delegationDepth ?? 0) > 0)
            return; // subagents: no gitmemo workflow or tools
        registerMemTools(agent.ctx, resolved);
        registerPromptSection(agent.ctx);
    });
}
export { Config, apply, inject, name };
