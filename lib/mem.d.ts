/** Schema version stored in `.gitmemo-format`. */
export declare const GITMEMO_FORMAT_VERSION = "2";
/** Format marker file tracked in the .mem repo (content = schema version). */
export declare const FORMAT_FILE = ".gitmemo-format";
/** Entry directory inside the .mem repo. */
export declare const ENTRY_DIR = "entries";
/** Sibling lock file (usable before `.mem` exists). */
export declare const LOCK_FILE_NAME = ".mem.gitmemo.lock";
/** Sibling journal used to recover an interrupted migration directory swap. */
export declare const MIGRATION_JOURNAL_NAME = ".mem.gitmemo-migration.json";
/** Max entry content size. */
export declare const MAX_CONTENT_BYTES: number;
/** Error type thrown by every gitmemo operation. */
export declare class GitMemoError extends Error {
}
/** Per-invocation engine options. */
export interface GitMemoConfig {
    /** Max search hits returned per call (page size). Default 20. */
    searchLimit?: number;
    /** Per git subprocess timeout in milliseconds. Default 60000. */
    gitTimeoutMs?: number;
    /** Cross-process lock wait timeout in milliseconds. Default 30000. */
    lockTimeoutMs?: number;
    /** @deprecated parsed for compatibility only — the memory dir is fixed at `<projectRoot>/.mem`. */
    memDirName?: string;
    /** @deprecated parsed for compatibility only — `.mem` always stays on main. */
    branchAlign?: boolean;
    /** @deprecated parsed for compatibility only — session-start recent seeding was removed. */
    recentContextLimit?: number;
}
/** One scored search hit. */
export interface SearchHit {
    hash: string;
    title: string;
    date: string;
    summary: string;
    keywords: string[];
    score: number;
    matched_keywords: string[];
}
export interface SearchOutput {
    snapshot: string;
    total: number;
    next_skip: number | null;
    results: SearchHit[];
    legacy?: boolean;
    warning?: string;
    diagnostics?: string[];
}
export interface SearchOptions {
    skip?: number;
    /** Snapshot returned by the first page — pass back unchanged for stable pagination. */
    snapshot?: string;
    /** @deprecated legacy `mode` — recall is always OR now. */
    mode?: "and" | "or" | "auto";
}
export interface WriteInput {
    /** Short "[module] action + object" title (single line, 1-200 chars). */
    title: string;
    /** 1-3 sentence summary (multi-line allowed, <= 4000 chars). */
    summary: string;
    /** 2-12 keywords (1-64 chars each); include 中英文 synonyms. Legacy writes may pass fewer. */
    keywords: string[];
    /** Memory markdown body (engine generates front matter). */
    content: string;
    related_branches?: string[];
    related_paths?: string[];
}
/** One-version compatibility shape accepted by the engine, not model-facing tools. */
export interface LegacyWriteInput {
    title: string;
    summary?: string;
    keywords?: string[];
    content?: string;
    related_branches?: string[];
    related_paths?: string[];
    body?: string;
    body_file?: string;
    content_file?: string;
    /** Old in-place updates conflict with immutable entries and are always rejected. */
    file?: string;
}
export interface WriteResult {
    hash: string;
    file: string;
    legacy?: boolean;
}
export interface ReadResult {
    hash: string;
    file: string;
    content: string;
    legacy?: boolean;
}
export interface DeleteInput {
    commit_hash: string;
    reason: string;
}
export interface ReplaceInput extends WriteInput {
    commit_hash: string;
}
/** Parsed structured commit message. */
export interface ParsedCommitMessage {
    subject: string;
    summary: string;
    type: "add" | "replace" | "delete" | "unknown";
    keywords: string[];
    digest?: string;
    deletes?: string;
    replaces?: string;
    legacy: boolean;
}
interface LogRecord {
    hash: string;
    committerTime: number;
    subject: string;
    body: string;
    added: string[];
    deleted: string[];
    message: ParsedCommitMessage;
}
interface TransactionJournal {
    operationId: string;
    operation: string;
    phase: string;
    baseHead: string;
    add: string[];
    delete: string[];
    digest?: string;
    createdAt: string;
}
export interface MigrationSwapJournal {
    operationId: string;
    sourceDir: string;
    targetDir: string;
    oldDir: string;
    tmpDir: string;
    phase: "prepared" | "old-renamed" | "new-installed";
    createdAt: string;
}
interface CodeContext {
    branch: string;
    commit: string;
}
interface GitOptions {
    input?: string;
    env?: NodeJS.ProcessEnv;
}
/** Run one git subprocess (internal; exported for migrate/cli). */
export declare function git(dir: string, args: string[], gitTimeoutMs: number, opts?: GitOptions): Promise<string>;
/**
 * Commit a message via stdin, retrying once with a built-in identity when the
 * ambient git configuration has no user.name/user.email (fresh machines,
 * CI, tests). The retry only adds env defaults — it never overrides an
 * explicitly configured identity.
 */
export declare function commitWithIdentity(memDir: string, message: string, gitTimeoutMs: number, opts?: GitOptions): Promise<string>;
/** `git init` with an explicit `main` branch (falls back for old git). */
export declare function gitInitMain(dir: string, gitTimeoutMs: number): Promise<void>;
/**
 * Resolve the code project root for a session working directory (plan 3.1):
 * explicit config > git work-tree root > session cwd.
 */
export declare function resolveProjectRoot(cwd: string, gitTimeoutMs?: number): Promise<string>;
/**
 * Query/write normalization contract: NFKC + Unicode default case folding +
 * whitespace collapsing to single ASCII spaces. Both query keywords and the
 * `GitMemo-Search-Text` projections use this exact function, so the first
 * grep stage never depends on the platform locale.
 */
export declare function normalizeText(input: string): string;
export declare function normalizeKeyword(input: string): string;
export interface ValidatedWriteInput {
    title: string;
    summary: string;
    keywords: string[];
    content: string;
    related_branches: string[];
    related_paths: string[];
}
/**
 * Validate a write/replace payload (plan 5.3). `legacy` relaxes the keyword
 * minimum to 0 (legacy adapter and migration entries); everything else is
 * enforced identically.
 */
export declare function validateWriteInput(input: WriteInput, legacy?: boolean): ValidatedWriteInput;
/**
 * Stable digest over the semantic payload only: title + summary +
 * normalized+sorted keywords + content. Write time, code branch/SHA and
 * related branches/paths are excluded, so the same conclusion never produces
 * an exact duplicate because of when/where it was written, and a withdrawn
 * conclusion can be re-written later.
 */
export declare function computeDigest(title: string, summary: string, keywords: string[], content: string): string;
/** UTC millisecond timestamp for filenames: `20260823T113612.123Z`. */
export declare function utcMs(date: Date): string;
/** ISO date for a committer timestamp; falls back to the epoch for out-of-range values. */
export declare function safeIsoDate(committerTime: number): string;
export declare function slugifyTitle(title: string): string;
/**
 * Create an entry file under entries/ with an exclusive create; on collision
 * append a numeric suffix. Never overwrites an existing file.
 */
export declare function createEntryFile(memDir: string, baseName: string, content: string): Promise<string>;
/** Build the full entry markdown (engine-generated front matter + body). */
export declare function buildEntryMarkdown(input: ValidatedWriteInput, ctx: CodeContext & {
    relatedBranches: string[];
}, digest: string, date: Date): string;
/** ADD commit message (plan 4.1). */
export declare function buildAddMessage(title: string, summary: string, keywords: string[], digest: string, legacy?: boolean): string;
/** DELETE commit message (plan 4.2). */
export declare function buildDeleteMessage(entryName: string, reason: string, deletesHash: string): string;
/** REPLACE commit message (plan 4.3). */
export declare function buildReplaceMessage(title: string, summary: string, keywords: string[], digest: string, replacesHash: string): string;
/**
 * Parse a commit message into logical search fields. The trailer block is the
 * contiguous run at the end; everything between subject and the block is the
 * summary. Malformed input degrades to `type: "unknown"` (legacy commits).
 */
export declare function parseCommitMessage(raw: string): ParsedCommitMessage;
/**
 * Parse the NUL-delimited log stream
 * (`--format=%x00%H%x00%ct%x00%s%x00%B%x00 --name-status --no-renames`).
 * Every commit contributes exactly five NUL-separated tokens followed by the
 * status tail, so records align rigidly regardless of newlines in bodies
 * (git itself forbids NUL inside commit messages).
 */
export declare function parseLogRecords(output: string): LogRecord[];
export declare function writeMigrationSwapJournal(root: string, journal: MigrationSwapJournal): Promise<void>;
/**
 * Recover the narrow two-rename migration swap window before any operation is
 * allowed to auto-initialize `.mem`. This prevents a crash between renames
 * from being mistaken for a genuinely fresh project.
 */
export declare function recoverMigrationSwap(root: string, gitTimeoutMs: number): Promise<void>;
/** Detect the repo format from `.gitmemo-format` at the given snapshot. */
export declare function repoFormat(memDir: string, gitTimeoutMs: number, snapshot?: string): Promise<"new" | "legacy">;
/** Resolve a ref/hash to a full commit hash or throw. */
export declare function resolveCommit(memDir: string, ref: string, gitTimeoutMs: number): Promise<string>;
/** Entry files added by one commit (single ADD/REPLACE mapping). */
export declare function addedFilesOf(memDir: string, hash: string, gitTimeoutMs: number): Promise<string[]>;
/**
 * Cross-process transaction lock (plan 8.1): exclusive create of a sibling
 * lock file, backed by an in-process mutex on the same canonical key. Used by
 * init/write/delete/replace/migrate; search/read take it briefly to resolve
 * their immutable snapshot (read barrier) and release before scanning.
 */
export declare function withLock<T>(root: string, opts: {
    lockTimeoutMs: number;
}, operation: string, fn: () => Promise<T>): Promise<T>;
/**
 * Strict journal recovery (plan 8.3): only when HEAD still equals the
 * journal's base and the worktree/index changes are exactly the planned
 * paths is the rollback performed; anything else aborts with repair guidance.
 */
export declare function rollbackJournal(memDir: string, journal: TransactionJournal, gitTimeoutMs: number): Promise<void>;
/**
 * Initialize a new-format `.mem` repo (plan 8.4): build the whole repo in a
 * sibling temp directory (init commit carries `.gitmemo-format` + `.gitkeep`
 * on `main`), then atomically rename it into place. Never converts an
 * existing legacy repo. Idempotent for already-initialized repos.
 */
export declare function ensureInit(root: string, memDir: string, gitTimeoutMs: number): Promise<void>;
/**
 * Git-backed long-term memory engine operating on one project root.
 * Every operation auto-initializes a new-format repo; legacy `.mem` repos
 * are migrated automatically on first use (no external CLI needed). Only
 * when automatic migration is blocked (conflicts, dirty worktree, ...) do
 * legacy repos stay read-only for search/read with a clear warning.
 */
export declare class GitMemo {
    readonly root: string;
    readonly memDir: string;
    private readonly config;
    constructor(root: string, config?: GitMemoConfig);
    /** Initialize the memory repo when missing (idempotent). Legacy repos are migrated automatically. */
    init(): Promise<string>;
    /**
     * Fully automatic legacy migration (no external CLI needed): when `.mem`
     * exists in legacy format, rebuild it into the new format in place —
     * dry-run + apply in one step. The caller must already hold the operation
     * lock. Blocking conditions (conflicts, dirty worktree, interrupted legacy
     * journal, ...) are returned, never thrown, so operations can fall back to
     * legacy read-only behavior; the next operation retries automatically.
     */
    private autoMigrateIfNeeded;
    /** Ensure the repo is initialized and writable (new format), migrating legacy repos automatically. */
    private ensureWritable;
    /**
     * Search past memories (plan 6): fixed-string OR grep recall over commit
     * messages only, active-entry filtering, field-level matching and scoring,
     * snapshot-stable pagination, in-process LRU.
     *
     * @param keywords - 1-12 keywords (legacy callers may pass a comma-separated string).
     * @param options.skip - pagination offset.
     * @param options.snapshot - pass back the snapshot from the first page.
     */
    search(keywords: string[] | string, options?: SearchOptions): Promise<SearchOutput>;
    private computeSearch;
    /**
     * Read one memory entry by create/replace commit hash. Historical entries
     * (deleted or replaced) stay readable for audit; `mem_read` accepts legacy
     * hashes too.
     */
    read(commitHash: string): Promise<ReadResult>;
    /**
     * Write a memory entry (plan 5.3). Entries are immutable: each write
     * creates a brand-new file `entries/<utc-ms>-<digest-prefix>-<slug>.md`
     * with one ADD commit. `legacy = true` relaxes the keyword minimum to 0
     * (compatibility adapter + migration reimports).
     */
    write(input: WriteInput | LegacyWriteInput, legacy?: boolean): Promise<WriteResult>;
    /**
     * Delete a memory entry (plan 5.4). Only withdraws the ACTIVE entry of a
     * create/replace hash; stale hashes are rejected.
     */
    delete(input: DeleteInput): Promise<{
        file: string;
    }>;
    /**
     * Replace an active entry (plan 5.5): one transaction, one commit deletes
     * the old file and adds the new one (never delete-then-write). The active
     * digest dedupe excludes the entry being replaced, so replacing with the
     * same digest but updated non-digest metadata (related branches/paths) is
     * legal; colliding with any OTHER active entry is rejected.
     */
    replace(input: ReplaceInput): Promise<WriteResult>;
}
export {};
