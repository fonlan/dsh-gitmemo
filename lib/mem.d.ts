/** Per-invocation engine options. */
export interface GitMemoConfig {
    /** Name of the memory repository directory at the project root. Default ".mem". */
    memDirName?: string;
    /** Maximum number of search hits returned per call. Default 20. */
    searchLimit?: number;
    /** Whether `.mem` branch follows the project branch on write. Default true. */
    branchAlign?: boolean;
    /** Per git subprocess timeout in milliseconds. Default 60000. */
    gitTimeoutMs?: number;
    /** Cap on git-log batches scanned by one search call. Default 200. */
    maxSearchBatches?: number;
}
/** One search hit, formatted `hash|title|date` like the original script. */
export interface SearchHit {
    hash: string;
    title: string;
    date: string;
}
export interface WriteOptions {
    /** Short "[module] action + object" title (required). */
    title: string;
    /** Entry markdown; provide exactly one of content / contentFile / file. */
    content?: string;
    /** Path to a file holding the entry markdown (temp file or an existing .mem/entries path). */
    contentFile?: string;
    /** Existing entry path to commit in place: `entries/foo.md`, `.mem/entries/foo.md`, or an absolute path under .mem. */
    file?: string;
    /** Optional single-line commit body. */
    body?: string;
    /** Optional path to a file holding the commit body. */
    bodyFile?: string;
}
export interface WriteResult {
    hash: string;
    file: string;
}
export interface SearchResult {
    mode: "and" | "or";
    results: SearchHit[];
}
/** True when a path points inside (or at) the memory entries directory. */
declare function isEntriesPath(memRoot: string, full: string): boolean;
/**
 * Git-backed long-term memory engine operating on one project root.
 */
export declare class GitMemo {
    readonly root: string;
    readonly memDir: string;
    private readonly config;
    constructor(root: string, config?: GitMemoConfig);
    /** The current branch of a git work tree, "main" when detached/unavailable. */
    private currentBranch;
    private projectBranch;
    private memBranch;
    /**
     * Initialize the memory repo when missing (git init + .gitkeep commit).
     * Idempotent; every other operation auto-initializes.
     */
    init(): Promise<string>;
    /** Align the memory repo branch with the project branch (create if needed). */
    private syncBranch;
    /**
     * Search past memories.
     * @param keywords - comma-separated keywords.
     * @param skip - pagination offset (default 0).
     * @param mode - "and" (strict), "or" (broad), or "auto" (AND first, OR fallback).
     */
    search(keywords: string, skip?: number, mode?: "and" | "or" | "auto"): Promise<SearchResult>;
    private runSearchMode;
    private acceptRecord;
    /** Resolve the entry file touched by a commit (first file under entries/). */
    private entryFileFromCommit;
    /** Read one memory entry by commit hash. */
    read(commitHash: string): Promise<{
        file: string;
        content: string;
    }>;
    /**
     * Write a memory entry.
     * Mirrors mem.sh write: commit a markdown entry under entries/ with an
     * optional body, aligning the .mem branch with the project branch first.
     */
    write(options: WriteOptions): Promise<WriteResult>;
    /** Delete a memory entry by commit hash. */
    delete(commitHash: string): Promise<string>;
}
/** Initialize the memory repo when missing. */
export declare function ensureInit(memDir: string, gitTimeoutMs?: number): Promise<void>;
export { isEntriesPath };
