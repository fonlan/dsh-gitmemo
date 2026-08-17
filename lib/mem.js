/**
 * GitMemo core engine — git-backed long-term memory for coding agents.
 *
 * A faithful TypeScript port of gitmemo's `scripts/mem.sh`:
 *   https://github.com/fonlan/gitmemo
 *
 * Memory lives in a local `.mem` Git repository at the project root.
 * Entries are markdown files under `.mem/entries/`, every action is a
 * commit (auditable/traceable), and the `.mem` branch is kept aligned with
 * the project's current branch on writes. Git is the only dependency.
 *
 * @module dsh-gitmemo/mem
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { dirname, basename, join, resolve, sep, isAbsolute } from "node:path";
const COMMIT_RE = /^[0-9a-f]{40}$/;
function git(dir, args, timeoutMs) {
    return new Promise((resolvePromise, reject) => {
        execFile("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error !== null) {
                const code = error.code;
                if (code === "ENOENT") {
                    reject(new Error("gitmemo: git not found on PATH — gitmemo requires the git CLI"));
                }
                else {
                    const message = (stderr ?? "").trim() || (error.message ?? String(error));
                    reject(new Error("gitmemo: git " + (args[0] ?? "") + " failed: " + message));
                }
                return;
            }
            resolvePromise(stdout);
        });
    });
}
/** Synchronous git runner for the session-start injection path (must not race the first prompt assembly). */
function gitSync(dir, args, timeoutMs) {
    try {
        // stdio must be pinned: execFileSync forwards child stderr to the parent's
        // console unless stdio is set, leaking raw `git fatal:` noise at boot.
        return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, stdio: "pipe" });
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            throw new Error("gitmemo: git not found on PATH — gitmemo requires the git CLI");
        }
        const stderr = error.stderr?.toString().trim();
        throw new Error("gitmemo: git " + (args[0] ?? "") + " failed: " + (stderr || String(error)));
    }
}
/** Parse one `git log --format=%H\t%s\t%cd --name-only` batch into records. */
function parseLogBatch(output) {
    const records = [];
    let currentHash = "";
    let currentSubject = "";
    let currentDate = "";
    let currentFile = "";
    for (const rawLine of output.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        if (line.length === 0)
            continue;
        const fields = line.split("\t");
        if (COMMIT_RE.test(fields[0] ?? "")) {
            if (currentHash.length > 0) {
                records.push({ hash: currentHash, title: currentSubject, date: currentDate, file: currentFile });
            }
            currentHash = fields[0];
            currentSubject = fields[1] ?? "";
            currentDate = fields.slice(2).join(" ").trim();
            currentFile = "";
            continue;
        }
        if (currentFile.length === 0 && line.startsWith("entries/") && line.endsWith(".md")) {
            currentFile = line;
        }
    }
    if (currentHash.length > 0) {
        records.push({ hash: currentHash, title: currentSubject, date: currentDate, file: currentFile });
    }
    return records;
}
/** True when a path points inside (or at) the memory entries directory. */
function isEntriesPath(memRoot, full) {
    const memEntries = join(memRoot, "entries") + sep;
    return full === join(memRoot, "entries") || full.startsWith(memEntries);
}
/**
 * Convert a user-supplied path to an entries-relative path when possible.
 * Handles `.mem/entries/...`, `entries/...`, and real files whose
 * resolved path lives under <memDir>/entries (resolved against baseDir).
 */
function entryFileFromPath(path, memDir, baseDir) {
    if (path.length === 0)
        return undefined;
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith(".mem/entries/"))
        return normalized.slice(".mem/".length);
    if (normalized.startsWith("entries/"))
        return normalized;
    // A real file whose resolved path lives under <memDir>/entries.
    const abs = isAbsolute(path) ? path : resolve(baseDir, path);
    if (isEntriesPath(memDir, abs)) {
        return abs.slice(memDir.length + 1).split(sep).join("/");
    }
    return undefined;
}
/** Normalize an entry file argument to the shape accepted by git add. */
function normalizeEntryFile(file, memDir, baseDir) {
    if (file.length === 0)
        return "";
    const direct = entryFileFromPath(file, memDir, baseDir);
    if (direct !== undefined)
        return direct;
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.startsWith("entries/") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
        return normalized;
    }
    return "entries/" + normalized;
}
/** Treat blank optional path arguments as omitted. */
function blankToUndefined(value) {
    return value !== undefined && value.trim().length === 0 ? undefined : value;
}
/** Reject paths that could escape the memory repo. */
function isSafeEntryPath(file) {
    if (file.startsWith("/") || file.includes("../") || file.endsWith("/..") || file.includes("\\") || file.includes(":")) {
        return false;
    }
    return true;
}
/** Lowercase title -> kebab slug; falls back to "memory-entry". */
function slugifyTitle(title) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");
    return slug.length > 0 ? slug : "memory-entry";
}
/** Current UTC timestamp in the filename format YYYYMMDDTHHMMSSZ. */
function utcTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
        "T" + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + "Z");
}
/**
 * Git-backed long-term memory engine operating on one project root.
 */
export class GitMemo {
    root;
    memDir;
    config;
    constructor(root, config = {}) {
        this.root = root;
        this.config = {
            memDirName: config.memDirName ?? ".mem",
            searchLimit: config.searchLimit ?? 20,
            branchAlign: config.branchAlign ?? true,
            gitTimeoutMs: config.gitTimeoutMs ?? 60000,
            maxSearchBatches: config.maxSearchBatches ?? 200
        };
        this.memDir = join(this.root, this.config.memDirName);
    }
    /** The current branch of a git work tree, "main" when detached/unavailable. */
    async currentBranch(dir) {
        try {
            const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], this.config.gitTimeoutMs)).trim();
            if (branch.length === 0 || branch === "HEAD")
                return "main";
            return branch;
        }
        catch {
            // Unborn HEAD (repo without commits yet): resolve the symbolic ref directly.
            try {
                const sym = (await git(dir, ["symbolic-ref", "--short", "HEAD"], this.config.gitTimeoutMs)).trim();
                if (sym.length > 0 && sym !== "HEAD")
                    return sym;
            }
            catch {
                // not a git repo at all
            }
            return "main";
        }
    }
    async projectBranch() {
        return this.currentBranch(this.root);
    }
    async memBranch() {
        return this.currentBranch(this.memDir);
    }
    /**
     * Initialize the memory repo when missing (git init + .gitkeep commit).
     * Idempotent; every other operation auto-initializes.
     */
    async init() {
        await ensureInit(this.memDir, this.config.gitTimeoutMs);
        return this.memDir;
    }
    /** Align the memory repo branch with the project branch (create if needed). */
    async syncBranch() {
        if (!this.config.branchAlign)
            return this.memBranch();
        const repoBranch = await this.projectBranch();
        const memBranch = await this.memBranch();
        if (memBranch !== repoBranch) {
            try {
                await git(this.memDir, ["show-ref", "--verify", "--quiet", "refs/heads/" + repoBranch], this.config.gitTimeoutMs);
                await git(this.memDir, ["checkout", "-q", repoBranch], this.config.gitTimeoutMs);
            }
            catch {
                await git(this.memDir, ["checkout", "-q", "-b", repoBranch], this.config.gitTimeoutMs);
            }
        }
        return repoBranch;
    }
    /**
     * Search past memories.
     * @param keywords - comma-separated keywords.
     * @param skip - pagination offset (default 0).
     * @param mode - "and" (strict), "or" (broad), or "auto" (AND first, OR fallback).
     */
    async search(keywords, skip = 0, mode = "auto") {
        const limit = this.config.searchLimit;
        await ensureInit(this.memDir, this.config.gitTimeoutMs);
        const keywordsList = keywords
            .split(",")
            .map((kw) => kw.trim())
            .filter((kw) => kw.length > 0);
        if (keywordsList.length === 0)
            throw new Error("gitmemo: search requires at least one non-empty keyword");
        if (!Number.isInteger(skip) || skip < 0)
            throw new Error("gitmemo: skip must be a non-negative integer");
        const normalizedMode = mode.toLowerCase();
        if (!["and", "or", "auto"].includes(normalizedMode)) {
            throw new Error("gitmemo: mode must be one of: and, or, auto");
        }
        const run = async (searchMode) => this.runSearchMode(keywordsList, searchMode, skip, limit);
        if (normalizedMode === "auto") {
            const andResults = await run("and");
            if (andResults.length >= 3)
                return { mode: "and", results: andResults };
            return { mode: "or", results: await run("or") };
        }
        return { mode: normalizedMode, results: await run(normalizedMode) };
    }
    async runSearchMode(keywords, mode, skip, limit) {
        const grepArgs = [];
        for (const kw of keywords)
            grepArgs.push("--grep=" + kw);
        if (mode === "and")
            grepArgs.push("--all-match");
        return this.scanLog(grepArgs, skip, limit);
    }
    /**
     * List the most recent memory entries across all branches, newest first.
     * Used to seed a new session's system prompt with a compact overview.
     * @param limit - maximum number of entries to return (0 returns none).
     */
    async recent(limit) {
        if (!Number.isInteger(limit) || limit < 0)
            throw new Error("gitmemo: recent limit must be a non-negative integer");
        if (limit === 0)
            return [];
        // Read-only: never creates the .mem repo (session-start injection must not touch the workspace).
        return this.scanLog([], 0, limit);
    }
    /** Active (non-deleted) entry files at HEAD. */
    async activeEntries() {
        try {
            const output = await git(this.memDir, ["ls-tree", "-r", "--name-only", "HEAD", "--", "entries/"], this.config.gitTimeoutMs);
            return new Set(output.split("\n").filter((line) => line.length > 0));
        }
        catch {
            return new Set();
        }
    }
    /** Shared git-log scan: keyword-grep optional, active-entry filtering, skip/limit. */
    async scanLog(grepArgs, skip, limit) {
        const active = await this.activeEntries();
        const results = [];
        let rawSkip = 0;
        let remainingSkip = skip;
        const batchSize = 200;
        for (let batch = 0; batch < this.config.maxSearchBatches && results.length < limit; batch += 1) {
            const args = [
                "log",
                ...grepArgs,
                "-i",
                "--skip=" + rawSkip,
                "--max-count=" + batchSize,
                "--format=%H\t%s\t%cd",
                "--date=iso",
                "--name-only",
                "--all",
                "--",
                "entries/"
            ];
            let output = "";
            try {
                output = await git(this.memDir, args, this.config.gitTimeoutMs);
            }
            catch {
                return results; // no history yet (or log failure) — nothing to search
            }
            if (output.trim().length === 0)
                break;
            const records = parseLogBatch(output);
            for (const record of records) {
                if (!this.acceptRecord(record.hash, record.title, record.file, active))
                    continue;
                if (remainingSkip > 0) {
                    remainingSkip -= 1;
                }
                else {
                    results.push({ hash: record.hash, title: record.title, date: record.date });
                    if (results.length >= limit)
                        break;
                }
            }
            if (results.length >= limit)
                break;
            if (records.length < batchSize)
                break;
            rawSkip += batchSize;
        }
        return results;
    }
    /**
     * Synchronous variant of {@link recent} for the session-start injection
     * path: blocks until the memory repo is scanned so the system-prompt
     * context can be registered before the first request assembles.
     */
    recentSync(limit) {
        if (!Number.isInteger(limit) || limit < 0)
            throw new Error("gitmemo: recent limit must be a non-negative integer");
        if (limit === 0)
            return [];
        let active = new Set();
        try {
            const output = gitSync(this.memDir, ["ls-tree", "-r", "--name-only", "HEAD", "--", "entries/"], this.config.gitTimeoutMs);
            active = new Set(output.split("\n").filter((line) => line.length > 0));
        }
        catch {
            return []; // no memory repo yet
        }
        const results = [];
        const batchSize = 200;
        let records = [];
        for (let rawSkip = 0, batch = 0; batch < this.config.maxSearchBatches && results.length < limit; rawSkip += batchSize, batch += 1) {
            const args = [
                "log",
                "--skip=" + rawSkip,
                "--max-count=" + batchSize,
                "--format=%H\t%s\t%cd",
                "--date=iso",
                "--name-only",
                "--all",
                "--",
                "entries/"
            ];
            let output;
            try {
                output = gitSync(this.memDir, args, this.config.gitTimeoutMs);
            }
            catch {
                return results;
            }
            if (output.trim().length === 0)
                break;
            records = parseLogBatch(output);
            for (const record of records) {
                if (!this.acceptRecord(record.hash, record.title, record.file, active))
                    continue;
                results.push({ hash: record.hash, title: record.title, date: record.date });
                if (results.length >= limit)
                    break;
            }
            if (results.length >= limit || records.length < batchSize)
                break;
        }
        return results;
    }
    acceptRecord(hash, subject, file, active) {
        void hash;
        if (subject.startsWith("delete: remove"))
            return false;
        if (file.length === 0 || !active.has(file))
            return false;
        return true;
    }
    /** Resolve the entry file touched by a commit (first file under entries/). */
    async entryFileFromCommit(commitHash) {
        let output = "";
        try {
            output = await git(this.memDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash, "--", "entries/"], this.config.gitTimeoutMs);
        }
        catch {
            return undefined;
        }
        let file = output.split("\n").find((line) => line.startsWith("entries/") && line.endsWith(".md"));
        if (file === undefined) {
            try {
                output = await git(this.memDir, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commitHash, "--", "entries/"], this.config.gitTimeoutMs);
                file = output.split("\n").find((line) => line.startsWith("entries/") && line.endsWith(".md"));
            }
            catch {
                return undefined;
            }
        }
        return file;
    }
    /** Read one memory entry by commit hash. */
    async read(commitHash) {
        if (!/^[0-9a-f]{7,}$/.test(commitHash))
            throw new Error("gitmemo: read requires a commit hash");
        await ensureInit(this.memDir, this.config.gitTimeoutMs);
        const file = await this.entryFileFromCommit(commitHash);
        if (file === undefined)
            throw new Error("gitmemo: no entry file found in commit " + commitHash);
        const content = await git(this.memDir, ["show", commitHash + ":" + file], this.config.gitTimeoutMs);
        return { file, content };
    }
    /**
     * Write a memory entry.
     * Mirrors mem.sh write: commit a markdown entry under entries/ with an
     * optional body, aligning the .mem branch with the project branch first.
     */
    async write(options) {
        await ensureInit(this.memDir, this.config.gitTimeoutMs);
        const { title, content } = options;
        const contentFile = blankToUndefined(options.contentFile);
        const file = blankToUndefined(options.file);
        const body = options.body;
        const bodyFile = blankToUndefined(options.bodyFile);
        if (title === undefined || title.trim().length === 0) {
            throw new Error("gitmemo: write requires --title");
        }
        if (body !== undefined && bodyFile !== undefined)
            throw new Error("gitmemo: use only one of body or body_file — pass the commit body inline via body and omit body_file");
        if (content !== undefined && contentFile !== undefined)
            throw new Error("gitmemo: use only one of content or contentFile");
        // Resolve optional payload paths against the engine root when relative.
        const resolvePayload = (p) => p === undefined ? undefined : (isAbsolute(p) ? p : resolve(this.root, p));
        const fullContentFile = resolvePayload(contentFile);
        const fullBodyFile = resolvePayload(bodyFile);
        if (fullContentFile !== undefined) {
            await fsAccess(fullContentFile).catch(() => {
                throw new Error("gitmemo: content file not found: " + fullContentFile);
            });
        }
        let resolvedBody = body;
        if (fullBodyFile !== undefined) {
            resolvedBody = await readFileSafe(fullBodyFile, "gitmemo: body file not found");
        }
        const directContentFile = fullContentFile !== undefined ? entryFileFromPath(fullContentFile, this.memDir, this.root) : undefined;
        let entryFile;
        if (file !== undefined) {
            entryFile = normalizeEntryFile(file, this.memDir, this.root);
            if (directContentFile !== undefined && entryFile !== directContentFile) {
                throw new Error("gitmemo: --file must match the existing .mem/entries path referenced by --content-file");
            }
        }
        else if (directContentFile !== undefined) {
            entryFile = directContentFile;
        }
        else if (content !== undefined || fullContentFile !== undefined) {
            entryFile = "entries/" + utcTimestamp() + "-" + slugifyTitle(title) + ".md";
        }
        else {
            throw new Error("gitmemo: missing content — use content, contentFile, or a pre-written .mem/entries file via file");
        }
        if (!isSafeEntryPath(entryFile))
            throw new Error("gitmemo: invalid file path: " + entryFile);
        const finalFile = entryFile.endsWith(".md") ? entryFile : entryFile + ".md";
        await this.syncBranch();
        const fullPath = join(this.memDir, finalFile);
        let useExisting = false;
        let deleteContentFile = false;
        if (directContentFile !== undefined) {
            useExisting = true;
        }
        else if (content === undefined && fullContentFile === undefined) {
            // Commit a pre-written entry file in place.
            useExisting = true;
        }
        else if (fullContentFile !== undefined) {
            deleteContentFile = true;
        }
        if (useExisting) {
            // The file must exist at its final path (after branch sync).
            try {
                await fsAccess(fullPath);
            }
            catch {
                throw new Error("gitmemo: existing entry file not found after branch sync: " + fullPath);
            }
        }
        else {
            await mkdir(dirname(fullPath), { recursive: true });
            if (fullContentFile !== undefined) {
                await copyFile(fullContentFile, fullPath);
            }
            else {
                await writeFile(fullPath, content ?? "", "utf8");
            }
        }
        await git(this.memDir, ["add", "--", finalFile], this.config.gitTimeoutMs);
        if (resolvedBody !== undefined && resolvedBody.trim().length > 0) {
            await git(this.memDir, ["commit", "-q", "-m", title, "-m", resolvedBody], this.config.gitTimeoutMs);
        }
        else {
            await git(this.memDir, ["commit", "-q", "-m", title], this.config.gitTimeoutMs);
        }
        const hash = (await git(this.memDir, ["rev-parse", "HEAD"], this.config.gitTimeoutMs)).trim();
        if (deleteContentFile && fullContentFile !== undefined) {
            await rm(fullContentFile, { force: true }).catch(() => {
                // Write succeeded; temp cleanup failure is only a warning.
            });
        }
        return { hash, file: finalFile };
    }
    /** Delete a memory entry by commit hash. */
    async delete(commitHash) {
        if (!/^[0-9a-f]{7,}$/.test(commitHash))
            throw new Error("gitmemo: delete requires a commit hash");
        await ensureInit(this.memDir, this.config.gitTimeoutMs);
        const file = await this.entryFileFromCommit(commitHash);
        if (file === undefined)
            throw new Error("gitmemo: no entry file found in commit " + commitHash);
        try {
            await fsAccess(join(this.memDir, file));
        }
        catch {
            throw new Error("gitmemo: file already deleted: " + file);
        }
        await git(this.memDir, ["rm", "-q", "--", file], this.config.gitTimeoutMs);
        await git(this.memDir, ["commit", "-q", "-m", "delete: remove " + basename(file, ".md")], this.config.gitTimeoutMs);
        return file;
    }
}
/** Initialize the memory repo when missing. */
export async function ensureInit(memDir, gitTimeoutMs = 60000) {
    let initialized = false;
    try {
        await fsAccess(join(memDir, ".git"));
        initialized = true;
    }
    catch {
        initialized = false;
    }
    if (initialized)
        return;
    await mkdir(join(memDir, "entries"), { recursive: true });
    await git(memDir, ["init", "-q"], gitTimeoutMs);
    await writeFile(join(memDir, "entries", ".gitkeep"), "", "utf8");
    await git(memDir, ["add", "entries/.gitkeep"], gitTimeoutMs);
    await git(memDir, ["commit", "-q", "-m", "init: initialize memory repo"], gitTimeoutMs);
}
async function fsAccess(path) {
    await import("node:fs/promises").then((fs) => fs.access(path));
}
async function readFileSafe(path, errorPrefix) {
    try {
        return await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
    }
    catch {
        throw new Error(errorPrefix + ": " + path);
    }
}
export { isEntriesPath };
