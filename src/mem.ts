/**
 * GitMemo core engine — git-backed long-term memory for coding agents.
 *
 * Mechanism:
 *  - `.mem` is a standalone git repository at the project root, permanently
 *    on a single `main` branch (no branch alignment with the code repo).
 *  - Entries are immutable markdown files under `.mem/entries/`, one file per
 *    ADD commit; corrections use `replace` (one commit deleting the old file
 *    and adding the new one), withdrawal uses `delete`.
 *  - Commit messages are structured: subject = title, body = summary, then a
 *    contiguous trailer block (`GitMemo-Type/Keyword/Digest/Deletes/Replaces/
 *    Search-Text/Legacy`). Search only reads commit messages via
 *    `git log --grep --fixed-strings`; entry bodies are never scanned.
 *  - All state transitions (init/write/delete/replace/migrate) run under a
 *    cross-process lock (sibling lock file + in-process mutex) with a short
 *    transaction journal for crash recovery. Git is the only dependency.
 *
 * @module dsh-gitmemo/mem
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Schema version stored in `.gitmemo-format`. */
export const GITMEMO_FORMAT_VERSION = "2";
/** Format marker file tracked in the .mem repo (content = schema version). */
export const FORMAT_FILE = ".gitmemo-format";
/** Entry directory inside the .mem repo. */
export const ENTRY_DIR = "entries";
/** Sibling lock file (usable before `.mem` exists). */
export const LOCK_FILE_NAME = ".mem.gitmemo.lock";
/** Sibling journal used to recover an interrupted migration directory swap. */
export const MIGRATION_JOURNAL_NAME = ".mem.gitmemo-migration.json";
/** Max entry content size. */
export const MAX_CONTENT_BYTES = 1024 * 1024;

/** Error type thrown by every gitmemo operation. */
export class GitMemoError extends Error {}

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

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  operation: string;
  operationId: string;
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

const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TRAILER_INJECT_RE = /^\s*GitMemo-[A-Za-z0-9-]+:/im;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SEARCH_CACHE_LIMIT = 32;

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

interface GitOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run one git subprocess (internal; exported for migrate/cli). */
export function git(dir: string, args: string[], gitTimeoutMs: number, opts: GitOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      ["-C", dir, ...args],
      {
        maxBuffer: 128 * 1024 * 1024,
        timeout: gitTimeoutMs,
        env: { ...process.env, ...opts.env }
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject(new GitMemoError("gitmemo: git not found on PATH — gitmemo requires the git CLI"));
          } else {
            const message = (stderr ?? "").trim() || (error.message ?? String(error));
            reject(new GitMemoError("gitmemo: git " + (args[0] ?? "") + " failed: " + message));
          }
          return;
        }
        resolvePromise(stdout);
      }
    );
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
  });
}

async function gitOk(dir: string, args: string[], gitTimeoutMs: number): Promise<boolean> {
  try {
    await git(dir, args, gitTimeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit a message via stdin, retrying once with a built-in identity when the
 * ambient git configuration has no user.name/user.email (fresh machines,
 * CI, tests). The retry only adds env defaults — it never overrides an
 * explicitly configured identity.
 */
export async function commitWithIdentity(
  memDir: string,
  message: string,
  gitTimeoutMs: number,
  opts: GitOptions = {}
): Promise<string> {
  const env = { ...process.env, ...opts.env };
  try {
    await git(memDir, ["commit", "-q", "-F", "-"], gitTimeoutMs, { input: message, env });
  } catch (error) {
    if (/user\.name|user\.email|Please tell me who you are|unable to auto-detect email/i.test(String(error))) {
      const fallback: NodeJS.ProcessEnv = {
        GIT_AUTHOR_NAME: "dsh-gitmemo",
        GIT_AUTHOR_EMAIL: "dsh-gitmemo@localhost",
        GIT_COMMITTER_NAME: "dsh-gitmemo",
        GIT_COMMITTER_EMAIL: "dsh-gitmemo@localhost"
      };
      await git(memDir, ["commit", "-q", "-F", "-"], gitTimeoutMs, { input: message, env: { ...env, ...fallback } });
    } else {
      throw error;
    }
  }
  return (await git(memDir, ["rev-parse", "HEAD"], gitTimeoutMs)).trim();
}

/** `git init` with an explicit `main` branch (falls back for old git). */
export async function gitInitMain(dir: string, gitTimeoutMs: number): Promise<void> {
  try {
    await git(dir, ["init", "-q", "-b", "main"], gitTimeoutMs);
  } catch {
    await git(dir, ["init", "-q"], gitTimeoutMs);
    await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"], gitTimeoutMs);
  }
}

/**
 * Resolve the code project root for a session working directory (plan 3.1):
 * explicit config > git work-tree root > session cwd.
 */
export async function resolveProjectRoot(cwd: string, gitTimeoutMs = 60000): Promise<string> {
  try {
    const out = (await git(cwd, ["rev-parse", "--show-toplevel"], gitTimeoutMs)).trim();
    if (out.length > 0) return out;
  } catch {
    // not inside a git work tree
  }
  return cwd;
}

// ---------------------------------------------------------------------------
// text normalization / validation
// ---------------------------------------------------------------------------

/**
 * Query/write normalization contract: NFKC + Unicode default case folding +
 * whitespace collapsing to single ASCII spaces. Both query keywords and the
 * `GitMemo-Search-Text` projections use this exact function, so the first
 * grep stage never depends on the platform locale.
 */
export function normalizeText(input: string): string {
  // JavaScript exposes Unicode case conversion but not CaseFolding.txt. NFKC
  // removes compatibility variants; the per-code-point rules below cover the
  // full-fold expansions and the small set where default folding intentionally
  // differs from ordinary lowercasing (Cherokee, final sigma, ypogegrammeni,
  // Cyrillic historic variants, and capital sharp S).
  const folded = [...input.normalize("NFKC")].map((char) => {
    const cp = char.codePointAt(0) ?? 0;
    if (char === "ẞ") return "ss";
    if (char === "\u0345") return "ι";
    if ((cp >= 0x13a0 && cp <= 0x13ff) || (cp >= 0xab70 && cp <= 0xabbf)) return char.toUpperCase();
    if (cp >= 0x1c80 && cp <= 0x1c88) return char.toUpperCase().toLowerCase();
    const upper = char.toUpperCase();
    if ([...upper].length > 1) return upper.toLowerCase();
    return char.toLowerCase();
  }).join("");
  return folded
    .replace(/ς/g, "σ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeKeyword(input: string): string {
  if (typeof input !== "string") throw new GitMemoError("gitmemo: keyword must be a string");
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new GitMemoError("gitmemo: keyword must not be empty");
  if (trimmed.length > 64) throw new GitMemoError("gitmemo: each keyword must be at most 64 characters: " + trimmed);
  assertNoControlChars(trimmed, "keyword");
  assertSingleLine(trimmed, "keyword");
  return normalizeText(trimmed);
}

function assertNoControlChars(value: string, field: string): void {
  if (UNSAFE_CONTROL_RE.test(value)) {
    throw new GitMemoError(`gitmemo: ${field} contains unsafe control characters`);
  }
}

function assertNoTrailerInjection(value: string, field: string): void {
  if (TRAILER_INJECT_RE.test(value)) {
    throw new GitMemoError(`gitmemo: ${field} must not contain reserved GitMemo-* trailer lines`);
  }
}

function assertSingleLine(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new GitMemoError(`gitmemo: ${field} must be a single line`);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Normalize a project-relative path; rejects absolute/escaping paths. */
function normalizeRelatedPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new GitMemoError("gitmemo: related_paths entries must not be empty");
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new GitMemoError("gitmemo: related_paths must be project-relative, got absolute path: " + trimmed);
  }
  if (UNSAFE_CONTROL_RE.test(trimmed)) {
    throw new GitMemoError("gitmemo: related_paths contains unsafe control characters");
  }
  const segments = trimmed.replaceAll("\\", "/").split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) throw new GitMemoError("gitmemo: related_paths escapes the project root: " + trimmed);
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) throw new GitMemoError("gitmemo: related_paths resolves to the project root: " + trimmed);
  return stack.join("/");
}

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
export function validateWriteInput(input: WriteInput, legacy = false): ValidatedWriteInput {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new GitMemoError("gitmemo: write requires a non-empty title");
  }
  const title = input.title.trim();
  assertSingleLine(title, "title");
  if (title.length > 200) throw new GitMemoError("gitmemo: title must be at most 200 characters");
  assertNoControlChars(title, "title");
  assertNoTrailerInjection(title, "title");

  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    throw new GitMemoError("gitmemo: write requires a non-empty summary");
  }
  const summary = input.summary.trim();
  if (summary.length > 4000) throw new GitMemoError("gitmemo: summary must be at most 4000 characters");
  assertNoControlChars(summary, "summary");
  assertNoTrailerInjection(summary, "summary");

  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new GitMemoError("gitmemo: write requires non-empty content");
  }
  const content = input.content;
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new GitMemoError("gitmemo: content must be at most 1 MiB");
  }
  assertNoControlChars(content, "content");

  if (!Array.isArray(input.keywords)) throw new GitMemoError("gitmemo: keywords must be an array");
  const rawKeywords = input.keywords.map((k) => (typeof k === "string" ? k.trim() : "")).filter((k) => k.length > 0);
  const minKeywords = legacy ? 0 : 2;
  if (rawKeywords.length < minKeywords || rawKeywords.length > 12) {
    throw new GitMemoError(
      `gitmemo: keywords must contain ${minKeywords === 0 ? "0-12" : "2-12"} entries, got ${rawKeywords.length}`
    );
  }
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const kw of rawKeywords) {
    assertSingleLine(kw, "keywords");
    assertNoTrailerInjection(kw, "keywords");
    const normalized = normalizeKeyword(kw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    keywords.push(kw);
  }
  if (keywords.length < minKeywords) {
    throw new GitMemoError(
      `gitmemo: keywords must contain ${minKeywords === 0 ? "0-12" : "2-12"} distinct entries after normalization, got ${keywords.length}`
    );
  }

  let related_branches: string[] = [];
  if (input.related_branches !== undefined) {
    if (!Array.isArray(input.related_branches)) throw new GitMemoError("gitmemo: related_branches must be an array");
    if (input.related_branches.length > 32) throw new GitMemoError("gitmemo: related_branches allows at most 32 entries");
    for (const b of input.related_branches) {
      const branch = typeof b === "string" ? b.trim() : "";
      if (branch.length === 0 || branch.length > 256) {
        throw new GitMemoError("gitmemo: related_branches entries must be 1-256 characters");
      }
      assertNoControlChars(branch, "related_branches");
      if (/[\r\n]/.test(branch)) throw new GitMemoError("gitmemo: related_branches must not contain newlines");
      related_branches.push(branch.normalize("NFKC"));
    }
    related_branches = dedupe(related_branches);
  }

  let related_paths: string[] = [];
  if (input.related_paths !== undefined) {
    if (!Array.isArray(input.related_paths)) throw new GitMemoError("gitmemo: related_paths must be an array");
    if (input.related_paths.length > 128) throw new GitMemoError("gitmemo: related_paths allows at most 128 entries");
    for (const p of input.related_paths) {
      const path = typeof p === "string" ? p : "";
      if (path.length === 0 || path.length > 1024) {
        throw new GitMemoError("gitmemo: related_paths entries must be 1-1024 characters");
      }
      related_paths.push(normalizeRelatedPath(path));
    }
    related_paths = dedupe(related_paths);
  }

  return { title, summary, keywords, content, related_branches, related_paths };
}

async function adaptLegacyWriteInput(input: WriteInput | LegacyWriteInput): Promise<WriteInput> {
  const legacyInput = input as LegacyWriteInput;
  if (legacyInput.file !== undefined) {
    throw new GitMemoError(
      "gitmemo: legacy mem_write `file` (in-place commit) is incompatible with immutable entries — use mem_replace"
    );
  }
  const readPayload = async (path: string | undefined): Promise<string | undefined> => {
    if (path === undefined || path.trim().length === 0) return undefined;
    return (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  };
  const summary = legacyInput.summary ?? legacyInput.body ?? (await readPayload(legacyInput.body_file));
  const content = legacyInput.content ?? (await readPayload(legacyInput.content_file));
  if (summary === undefined || content === undefined) {
    throw new GitMemoError(
      "gitmemo: legacy write cannot be converted deterministically — provide title plus summary/body and content/content_file"
    );
  }
  return {
    title: legacyInput.title,
    summary,
    keywords: legacyInput.keywords ?? [],
    content,
    related_branches: legacyInput.related_branches,
    related_paths: legacyInput.related_paths
  };
}

// ---------------------------------------------------------------------------
// digest / filenames / markdown / commit messages
// ---------------------------------------------------------------------------

/**
 * Stable digest over the semantic payload only: title + summary +
 * normalized+sorted keywords + content. Write time, code branch/SHA and
 * related branches/paths are excluded, so the same conclusion never produces
 * an exact duplicate because of when/where it was written, and a withdrawn
 * conclusion can be re-written later.
 */
export function computeDigest(title: string, summary: string, keywords: string[], content: string): string {
  const normalizedKeywords = [...new Set(keywords.map((k) => normalizeKeyword(k)))].sort();
  const payload = JSON.stringify({ title, summary, keywords: normalizedKeywords, content });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** UTC millisecond timestamp for filenames: `20260823T113612.123Z`. */
export function utcMs(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "19700101T000000.000Z";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "." +
    String(date.getUTCMilliseconds()).padStart(3, "0") +
    "Z"
  );
}

/** ISO date for a committer timestamp; falls back to the epoch for out-of-range values. */
export function safeIsoDate(committerTime: number): string {
  const ms = committerTime * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "memory-entry";
}

/**
 * Create an entry file under entries/ with an exclusive create; on collision
 * append a numeric suffix. Never overwrites an existing file.
 */
export async function createEntryFile(memDir: string, baseName: string, content: string): Promise<string> {
  const dir = join(memDir, ENTRY_DIR);
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    const name = attempt === 0 ? baseName : baseName.replace(/\.md$/, `-${attempt + 1}.md`);
    const full = join(dir, name);
    try {
      const handle = await open(full, "wx");
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      return ENTRY_DIR + "/" + name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

/**
 * Journal an exact new-entry path before its first filesystem mutation, then
 * create it exclusively. The transaction lock makes the existence probe and
 * journal write deterministic for compliant writers; `wx` remains the final
 * defence against external races.
 */
async function createJournaledEntryFile(
  memDir: string,
  baseName: string,
  content: string,
  makeJournal: (file: string) => TransactionJournal
): Promise<{ file: string; journal: TransactionJournal }> {
  const dir = join(memDir, ENTRY_DIR);
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    const name = attempt === 0 ? baseName : baseName.replace(/\.md$/, `-${attempt + 1}.md`);
    const file = ENTRY_DIR + "/" + name;
    const full = join(memDir, file);
    if (await pathExists(full)) continue;
    const journal = makeJournal(file);
    await writeJournal(memDir, journal);
    try {
      const handle = await open(full, "wx");
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
      return { file, journal };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await rm(journalPath(memDir), { force: true });
        continue;
      }
      throw error;
    }
  }
}

function yamlJson(value: unknown): string {
  return JSON.stringify(value);
}

/** YAML flow array with human-readable ", " separators. */
function yamlArray(values: string[]): string {
  return "[" + values.map((v) => JSON.stringify(v)).join(", ") + "]";
}

/** Build the full entry markdown (engine-generated front matter + body). */
export function buildEntryMarkdown(
  input: ValidatedWriteInput,
  ctx: CodeContext & { relatedBranches: string[] },
  digest: string,
  date: Date
): string {
  void digest;
  const lines = [
    "---",
    "gitmemo_version: " + yamlJson(GITMEMO_FORMAT_VERSION),
    "date: " + yamlJson(date.toISOString()),
    "code_branch: " + yamlJson(ctx.branch),
    "code_commit: " + yamlJson(ctx.commit),
    "related_branches: " + yamlArray(ctx.relatedBranches),
    "related_paths: " + yamlArray(input.related_paths),
    "keywords: " + yamlArray(input.keywords),
    "---",
    "",
    "# " + input.title,
    "",
    "## Summary",
    "",
    input.summary,
    "",
    "## Final Outcome",
    "",
    input.content,
    ""
  ];
  return lines.join("\n");
}

function searchTexts(title: string, summary: string, keywords: string[]): string[] {
  return [normalizeText(title), normalizeText(summary.replace(/\s+/g, " ")), ...keywords.map((k) => normalizeText(k))];
}

/** ADD commit message (plan 4.1). */
export function buildAddMessage(
  title: string,
  summary: string,
  keywords: string[],
  digest: string,
  legacy = false
): string {
  const lines = [title, "", summary, "", "GitMemo-Type: add"];
  if (legacy) lines.push("GitMemo-Legacy: true");
  for (const kw of keywords) lines.push("GitMemo-Keyword: " + kw);
  lines.push("GitMemo-Digest: sha256:" + digest);
  for (const text of searchTexts(title, summary, keywords)) lines.push("GitMemo-Search-Text: " + text);
  return lines.join("\n") + "\n";
}

/** DELETE commit message (plan 4.2). */
export function buildDeleteMessage(entryName: string, reason: string, deletesHash: string): string {
  return [
    "delete: withdraw " + entryName,
    "",
    reason,
    "",
    "GitMemo-Type: delete",
    "GitMemo-Deletes: " + deletesHash
  ].join("\n") + "\n";
}

/** REPLACE commit message (plan 4.3). */
export function buildReplaceMessage(
  title: string,
  summary: string,
  keywords: string[],
  digest: string,
  replacesHash: string
): string {
  const lines = [title, "", summary, "", "GitMemo-Type: replace", "GitMemo-Replaces: " + replacesHash];
  for (const kw of keywords) lines.push("GitMemo-Keyword: " + kw);
  lines.push("GitMemo-Digest: sha256:" + digest);
  for (const text of searchTexts(title, summary, keywords)) lines.push("GitMemo-Search-Text: " + text);
  return lines.join("\n") + "\n";
}

/**
 * Parse a commit message into logical search fields. The trailer block is the
 * contiguous run at the end; everything between subject and the block is the
 * summary. Malformed input degrades to `type: "unknown"` (legacy commits).
 */
export function parseCommitMessage(raw: string): ParsedCommitMessage {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const subject = (lines[0] ?? "").trim();
  let trailerStart = lines.length;
  while (trailerStart > 1) {
    const trimmed = lines[trailerStart - 1].trim();
    if (trimmed.length === 0) {
      trailerStart -= 1;
      continue;
    }
    if (/^GitMemo-[A-Za-z0-9-]+:/.test(trimmed)) {
      trailerStart -= 1;
      continue;
    }
    break;
  }
  const summary = lines
    .slice(1, trailerStart)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const trailers = new Map<string, string[]>();
  for (let i = trailerStart; i < lines.length; i += 1) {
    const match = /^GitMemo-([A-Za-z0-9-]+): ?(.*)$/.exec(lines[i].trim());
    if (match !== null) {
      const list = trailers.get(match[1]) ?? [];
      list.push(match[2]);
      trailers.set(match[1], list);
    }
  }
  const typeRaw = trailers.get("Type")?.[0] ?? "unknown";
  const type: ParsedCommitMessage["type"] =
    typeRaw === "add" || typeRaw === "replace" || typeRaw === "delete" ? typeRaw : "unknown";
  return {
    subject,
    summary,
    type,
    keywords: trailers.get("Keyword") ?? [],
    digest: trailers.get("Digest")?.[0]?.replace(/^sha256:/, "") || undefined,
    deletes: trailers.get("Deletes")?.[0] || undefined,
    replaces: trailers.get("Replaces")?.[0] || undefined,
    legacy: trailers.get("Legacy")?.[0] === "true"
  };
}

// ---------------------------------------------------------------------------
// git log parsing
// ---------------------------------------------------------------------------

function parseStatusTail(tail: string): { added: string[]; deleted: string[] } {
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of tail.split("\n")) {
    const add = /^A\t(entries\/.+\.md)$/.exec(line);
    if (add !== null) {
      added.push(add[1]);
      continue;
    }
    const del = /^D\t(entries\/.+\.md)$/.exec(line);
    if (del !== null) {
      deleted.push(del[1]);
      continue;
    }
    const rename = /^R\d+\t(entries\/.+\.md)\t(entries\/.+\.md)$/.exec(line);
    if (rename !== null) {
      deleted.push(rename[1]);
      added.push(rename[2]);
    }
  }
  return { added, deleted };
}

/**
 * Parse the NUL-delimited log stream
 * (`--format=%x00%H%x00%ct%x00%s%x00%B%x00 --name-status --no-renames`).
 * Every commit contributes exactly five NUL-separated tokens followed by the
 * status tail, so records align rigidly regardless of newlines in bodies
 * (git itself forbids NUL inside commit messages).
 */
export function parseLogRecords(output: string): LogRecord[] {
  const tokens = output.split("\0");
  const records: LogRecord[] = [];
  for (let i = 1; i + 4 < tokens.length; i += 5) {
    const hash = tokens[i];
    if (!COMMIT_RE.test(hash)) continue;
    const committerTime = Number(tokens[i + 1]);
    if (!Number.isFinite(committerTime)) continue;
    const body = tokens[i + 3] ?? "";
    const { added, deleted } = parseStatusTail(tokens[i + 4] ?? "");
    records.push({ hash, committerTime, subject: tokens[i + 2] ?? "", body, added, deleted, message: parseCommitMessage(body) });
  }
  return records;
}

/** Map every active entry file to its current create/replace commit (newest ADD/REPLACE wins). */
function claimedActiveEntries(
  records: LogRecord[],
  active: Set<string>
): { claimed: Map<string, { hash: string; digest?: string }>; diagnostics: string[] } {
  const claimed = new Map<string, { hash: string; digest?: string }>();
  const diagnostics: string[] = [];
  for (const record of records) {
    if (record.added.length !== 1) {
      if (record.added.length > 1 && (record.message.type === "add" || record.message.type === "replace")) {
        diagnostics.push(`commit ${record.hash} adds ${record.added.length} entries; expected exactly one`);
      }
      continue;
    }
    const file = record.added[0];
    if (!active.has(file) || claimed.has(file)) continue;
    claimed.set(file, { hash: record.hash, digest: record.message.digest });
  }
  return { claimed, diagnostics };
}

// ---------------------------------------------------------------------------
// repo state helpers
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function migrationJournalPath(root: string): string {
  return join(root, MIGRATION_JOURNAL_NAME);
}

export async function writeMigrationSwapJournal(root: string, journal: MigrationSwapJournal): Promise<void> {
  const target = migrationJournalPath(root);
  const tmp = target + ".tmp-" + process.pid + "-" + randomBytes(4).toString("hex");
  await writeFile(tmp, JSON.stringify(journal, null, 2) + "\n", "utf8");
  try {
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Recover the narrow two-rename migration swap window before any operation is
 * allowed to auto-initialize `.mem`. This prevents a crash between renames
 * from being mistaken for a genuinely fresh project.
 */
export async function recoverMigrationSwap(root: string, gitTimeoutMs: number): Promise<void> {
  let journal: MigrationSwapJournal;
  try {
    journal = JSON.parse(await readFile(migrationJournalPath(root), "utf8")) as MigrationSwapJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new GitMemoError(
      `gitmemo: migration recovery journal is unreadable (${migrationJournalPath(root)}): ${String(error)}. ` +
        "Inspect the journal and migration backup directories before continuing."
    );
  }
  const canonicalRoot = resolve(root);
  const expectedTarget = join(canonicalRoot, ".mem");
  const safeSibling = (path: string, prefix: string) =>
    dirname(resolve(path)) === canonicalRoot && basename(path).startsWith(prefix);
  if (
    resolve(journal.targetDir) !== expectedTarget ||
    !safeSibling(journal.oldDir, ".mem.gitmemo-old-") ||
    !safeSibling(journal.tmpDir, ".mem.gitmemo-tmp-")
  ) {
    throw new GitMemoError(
      `gitmemo: migration recovery journal contains unsafe paths (${migrationJournalPath(root)}); refusing automatic filesystem changes`
    );
  }
  const sourceExists = await pathExists(journal.sourceDir);
  const targetExists = await pathExists(journal.targetDir);
  const oldExists = await pathExists(journal.oldDir);
  const tmpExists = await pathExists(journal.tmpDir);

  const targetIsNew = targetExists && (await pathExists(join(journal.targetDir, ".git"))) &&
    (await repoFormat(journal.targetDir, gitTimeoutMs, "HEAD")) === "new";
  if (targetIsNew && resolve(journal.sourceDir) !== expectedTarget) {
    // A non-default legacy source is never moved: migration only installs the
    // newly built canonical `.mem`, so recovery finalizes without touching the
    // source repository.
    if (tmpExists && resolve(journal.tmpDir) !== expectedTarget) await rm(journal.tmpDir, { recursive: true, force: true });
    await rm(migrationJournalPath(root), { force: true });
    return;
  }
  if (targetIsNew && oldExists) {
    await rm(journal.oldDir, { recursive: true, force: true });
    if (tmpExists && journal.tmpDir !== journal.targetDir) await rm(journal.tmpDir, { recursive: true, force: true });
    await rm(migrationJournalPath(root), { force: true });
    return;
  }
  if (!sourceExists && oldExists && resolve(journal.sourceDir) === expectedTarget) {
    await rename(journal.oldDir, journal.sourceDir);
    if (tmpExists) await rm(journal.tmpDir, { recursive: true, force: true });
    await rm(migrationJournalPath(root), { force: true });
    return;
  }
  if (sourceExists && (!targetExists || (journal.sourceDir === journal.targetDir && !oldExists))) {
    if (tmpExists) await rm(journal.tmpDir, { recursive: true, force: true });
    await rm(migrationJournalPath(root), { force: true });
    return;
  }
  throw new GitMemoError(
    `gitmemo: interrupted migration swap cannot be recovered automatically (${migrationJournalPath(root)}). ` +
      `source=${journal.sourceDir}, target=${journal.targetDir}, backup=${journal.oldDir}, tmp=${journal.tmpDir}. ` +
      "Inspect these directories and restore exactly one canonical .mem repository before deleting the migration journal."
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function legacyWarning(root: string): string {
  return (
    "gitmemo: .mem is in legacy format — search is read-only over the current branch. " +
    `Run \`dsh-gitmemo migrate --project-root ${root} --dry-run\` to plan migration (then --apply).`
  );
}

/** Detect the repo format from `.gitmemo-format` at the given snapshot. */
export async function repoFormat(memDir: string, gitTimeoutMs: number, snapshot = "HEAD"): Promise<"new" | "legacy"> {
  try {
    const out = (await git(memDir, ["show", snapshot + ":.gitmemo-format"], gitTimeoutMs)).trim();
    return out === GITMEMO_FORMAT_VERSION ? "new" : "legacy";
  } catch {
    return "legacy";
  }
}

/** Resolve a ref/hash to a full commit hash or throw. */
export async function resolveCommit(memDir: string, ref: string, gitTimeoutMs: number): Promise<string> {
  try {
    return (await git(memDir, ["rev-parse", "--verify", ref + "^{commit}"], gitTimeoutMs)).trim();
  } catch {
    throw new GitMemoError("gitmemo: no such commit: " + ref);
  }
}

/** Entry files added by one commit (single ADD/REPLACE mapping). */
export async function addedFilesOf(memDir: string, hash: string, gitTimeoutMs: number): Promise<string[]> {
  let output = "";
  try {
    output = await git(
      memDir,
      ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", hash, "--", ENTRY_DIR + "/"],
      gitTimeoutMs
    );
  } catch {
    return [];
  }
  const added: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^A\t(entries\/.+\.md)$/.exec(line);
    if (match !== null) added.push(match[1]);
  }
  return added;
}

/** ls-tree active set + full per-commit record map at a fixed snapshot. */
async function activeSnapshot(
  memDir: string,
  snapshot: string,
  gitTimeoutMs: number
): Promise<{
  active: Set<string>;
  records: LogRecord[];
  claimed: Map<string, { hash: string; digest?: string }>;
  diagnostics: string[];
}> {
  const activeOut = await git(memDir, ["ls-tree", "-r", "--name-only", snapshot, "--", ENTRY_DIR + "/"], gitTimeoutMs);
  const active = new Set(activeOut.split("\n").filter((line) => line.length > 0));
  const logOut = await git(
    memDir,
    [
      "log",
      snapshot,
      "--format=%x00%H%x00%ct%x00%s%x00%B%x00",
      "--name-status",
      "--no-renames",
      "--",
      ENTRY_DIR + "/"
    ],
    gitTimeoutMs
  );
  const records = parseLogRecords(logOut);
  const { claimed, diagnostics } = claimedActiveEntries(records, active);
  return { active, records, claimed, diagnostics };
}

/**
 * Resolve the search snapshot. New-format repos use refs/heads/main; legacy
 * repos (no format marker, or no main) fall back to the current HEAD,
 * read-only. A caller-supplied snapshot must still be an ancestor of the
 * current main, otherwise it is stale.
 */
async function resolveSnapshot(
  memDir: string,
  gitTimeoutMs: number,
  root: string,
  input?: string
): Promise<{ snapshot: string; legacy: boolean; warning?: string }> {
  let main = "";
  try {
    main = (await git(memDir, ["rev-parse", "--verify", "refs/heads/main^{commit}"], gitTimeoutMs)).trim();
  } catch {
    main = "";
  }
  if (main.length === 0) {
    let head = "";
    try {
      head = (await git(memDir, ["rev-parse", "--verify", "HEAD^{commit}"], gitTimeoutMs)).trim();
    } catch {
      throw new GitMemoError(
        "gitmemo: .mem has neither a main branch nor a HEAD commit — the repo is unreadable; run `dsh-gitmemo migrate` or re-initialize"
      );
    }
    if ((await repoFormat(memDir, gitTimeoutMs, head)) === "new") {
      throw new GitMemoError(
        "gitmemo: new-format .mem repository is missing refs/heads/main — the repository is damaged; restore main explicitly before continuing"
      );
    }
    if (input !== undefined) {
      const full = await resolveCommit(memDir, input, gitTimeoutMs);
      if (!(await gitOk(memDir, ["merge-base", "--is-ancestor", full, head], gitTimeoutMs))) {
        throw new GitMemoError(`gitmemo: stale legacy snapshot ${input} is no longer part of the current HEAD history — restart pagination`);
      }
      return { snapshot: full, legacy: true, warning: legacyWarning(root) };
    }
    return { snapshot: head, legacy: true, warning: legacyWarning(root) };
  }
  const format = await repoFormat(memDir, gitTimeoutMs, main);
  if (format !== "new") {
    if (input !== undefined) {
      const full = await resolveCommit(memDir, input, gitTimeoutMs);
      if (!(await gitOk(memDir, ["merge-base", "--is-ancestor", full, main], gitTimeoutMs))) {
        throw new GitMemoError(`gitmemo: stale legacy snapshot ${input} is no longer part of the current branch history — restart pagination`);
      }
      return { snapshot: full, legacy: true, warning: legacyWarning(root) };
    }
    return { snapshot: main, legacy: true, warning: legacyWarning(root) };
  }
  if (input !== undefined) {
    const full = await resolveCommit(memDir, input, gitTimeoutMs);
    const ancestor = await gitOk(memDir, ["merge-base", "--is-ancestor", full, main], gitTimeoutMs);
    if (!ancestor) {
      throw new GitMemoError(
        `gitmemo: stale snapshot ${input} is no longer part of the current main history — re-run mem_search from the first page`
      );
    }
    return { snapshot: full, legacy: false };
  }
  return { snapshot: main, legacy: false };
}

/** Entry currently active at a snapshot, verified by its create/replace hash. */
async function activeEntryForHash(
  memDir: string,
  fullHash: string,
  snapshot: string,
  gitTimeoutMs: number
): Promise<{ file: string; message: ParsedCommitMessage }> {
  const body = await git(memDir, ["log", "-1", "--format=%B", fullHash], gitTimeoutMs);
  const message = parseCommitMessage(body);
  if (message.type !== "add" && message.type !== "replace") {
    throw new GitMemoError(`gitmemo: commit ${fullHash} is not a gitmemo entry (add/replace) commit`);
  }
  const added = await addedFilesOf(memDir, fullHash, gitTimeoutMs);
  if (added.length !== 1) {
    throw new GitMemoError(
      `gitmemo: commit ${fullHash} maps to ${added.length} entry files — cannot resolve a single entry`
    );
  }
  const file = added[0];
  const activeHash = (await git(memDir, ["log", "-1", "--format=%H", snapshot, "--", file], gitTimeoutMs)).trim();
  if (activeHash !== fullHash) {
    throw new GitMemoError(
      `gitmemo: commit ${fullHash} is not the active entry for ${file} (active: ${activeHash || "none"}) — use the hash returned by mem_search`
    );
  }
  return { file, message };
}

// ---------------------------------------------------------------------------
// locking
// ---------------------------------------------------------------------------

const processMutexes = new Map<string, Promise<unknown>>();

function withProcessMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = processMutexes.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  processMutexes.set(key, next);
  // Observe the chain without propagating: the caller owns the outcome, and a
  // discarded rejection here would surface as an unhandledRejection.
  const cleanup = () => {
    if (processMutexes.get(key) === next) processMutexes.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function staleLock(lockPath: string, lockTimeoutMs: number): Promise<boolean> {
  let info: LockInfo | undefined;
  try {
    info = JSON.parse(await readFile(lockPath, "utf8")) as LockInfo;
  } catch {
    return false;
  }
  if (typeof info.pid !== "number" || info.host !== hostname()) return false;
  if (isProcessAlive(info.pid)) return false;
  const started = Date.parse(info.startedAt);
  if (Number.isNaN(started)) return false;
  // Only clear locks that are both dead and safely beyond any plausible live
  // transaction duration; never force-break a lock we cannot judge.
  return Date.now() - started > Math.max(10000, lockTimeoutMs * 2);
}

/**
 * Cross-process transaction lock (plan 8.1): exclusive create of a sibling
 * lock file, backed by an in-process mutex on the same canonical key. Used by
 * init/write/delete/replace/migrate; search/read take it briefly to resolve
 * their immutable snapshot (read barrier) and release before scanning.
 */
export async function withLock<T>(
  root: string,
  opts: { lockTimeoutMs: number },
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = resolve(root);
  return withProcessMutex(key, async () => {
    const lockPath = join(key, LOCK_FILE_NAME);
    const operationId = randomUUID();
    const deadline = Date.now() + opts.lockTimeoutMs;
    const payload = JSON.stringify(
      { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), operation, operationId } satisfies LockInfo,
      null,
      2
    ) + "\n";
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(payload, "utf8");
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new GitMemoError("gitmemo: cannot create lock file " + lockPath + ": " + String(error));
        }
        if (await staleLock(lockPath, opts.lockTimeoutMs)) {
          await rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() >= deadline) {
          throw new GitMemoError(
            `gitmemo: timed out after ${opts.lockTimeoutMs}ms waiting for lock ${lockPath} (held by another gitmemo process). ` +
              "If no other process is running, remove the stale lock file manually."
          );
        }
        await sleep(40 + Math.floor(Math.random() * 60));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true }).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// init / journal / cleanliness
// ---------------------------------------------------------------------------

function journalPath(memDir: string): string {
  return join(memDir, ".git", "gitmemo-transaction.json");
}

async function writeJournal(memDir: string, journal: TransactionJournal): Promise<void> {
  const target = journalPath(memDir);
  const tmp = target + ".tmp-" + process.pid + "-" + randomBytes(4).toString("hex");
  await writeFile(tmp, JSON.stringify(journal, null, 2) + "\n", "utf8");
  try {
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

async function readJournal(memDir: string): Promise<TransactionJournal | undefined> {
  try {
    return JSON.parse(await readFile(journalPath(memDir), "utf8")) as TransactionJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new GitMemoError(
      `gitmemo: transaction journal is unreadable (${journalPath(memDir)}): ${String(error)} — inspect it before continuing`
    );
  }
}

function repairMessage(memDir: string, journal: TransactionJournal, reason: string): string {
  return (
    "gitmemo: interrupted transaction detected (" + journalPath(memDir) + "): " + reason + ". " +
    "Automatic rollback is refused because the repository state does not match the journal. " +
    "Inspect `git -C " + memDir + " status` and the journal, then either restore the repo to a clean state " +
    "and delete the journal file, or finish the operation manually."
  );
}

/**
 * Strict journal recovery (plan 8.3): only when HEAD still equals the
 * journal's base and the worktree/index changes are exactly the planned
 * paths is the rollback performed; anything else aborts with repair guidance.
 */
export async function rollbackJournal(memDir: string, journal: TransactionJournal, gitTimeoutMs: number): Promise<void> {
  const planned = new Set([...journal.add, ...journal.delete]);
  const head = (await git(memDir, ["rev-parse", "HEAD"], gitTimeoutMs)).trim();
  if (head !== journal.baseHead) {
    // A commit may have succeeded immediately before journal cleanup failed or
    // the process exited. Treat that exact, clean one-commit transition as
    // completed instead of permanently blocking all future transactions.
    const status = (await git(memDir, ["status", "--porcelain"], gitTimeoutMs)).trim();
    const parent = await git(memDir, ["rev-parse", "HEAD^"], gitTimeoutMs).then((s) => s.trim()).catch(() => "");
    const changed = (await git(memDir, ["diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", "HEAD"], gitTimeoutMs))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [statusCode, ...parts] = line.split("\t");
        return { status: statusCode, path: parts.join("\t") };
      });
    const expected = [
      ...journal.add.map((path) => ({ status: "A", path })),
      ...journal.delete.map((path) => ({ status: "D", path }))
    ];
    const sort = (items: Array<{ status: string; path: string }>) => [...items].sort((a, b) => a.path.localeCompare(b.path));
    const a = sort(changed);
    const e = sort(expected);
    if (status.length === 0 && parent === journal.baseHead && a.length === e.length && a.every((item, i) => item.status === e[i].status && item.path === e[i].path)) {
      await rm(journalPath(memDir), { force: true });
      return;
    }
    throw new GitMemoError(repairMessage(memDir, journal, `HEAD moved since the journal was written (${journal.baseHead} → ${head})`));
  }
  const [stagedOut, unstagedOut, untrackedOut] = await Promise.all([
    git(memDir, ["diff", "--cached", "--name-only", "--no-renames"], gitTimeoutMs),
    git(memDir, ["diff", "--name-only", "--no-renames"], gitTimeoutMs),
    git(memDir, ["ls-files", "--others", "--exclude-standard"], gitTimeoutMs)
  ]);
  const statusPaths = dedupe(
    [stagedOut, unstagedOut, untrackedOut]
      .flatMap((out) => out.split("\n"))
      .filter((path) => path.length > 0)
  );
  // A journal is deliberately written before the first file mutation. A
  // crash can therefore leave none or only a subset of the planned paths;
  // that is safe to roll back as long as no unknown path is present.
  if (statusPaths.some((p) => !planned.has(p))) {
    throw new GitMemoError(repairMessage(memDir, journal, "worktree/index changes do not match the journal plan"));
  }
  for (const path of journal.add) {
    await rm(join(memDir, path), { force: true }).catch(() => {});
    await git(memDir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", path], gitTimeoutMs).catch(() => {});
  }
  for (const path of journal.delete) {
    await git(memDir, ["checkout", "-q", journal.baseHead, "--", path], gitTimeoutMs).catch(() => {});
  }
  const after = (await git(memDir, ["status", "--porcelain"], gitTimeoutMs)).trim();
  if (after.length > 0) {
    throw new GitMemoError(repairMessage(memDir, journal, "rollback left the worktree dirty — inspect manually"));
  }
  await rm(journalPath(memDir), { force: true });
}

async function recoverJournal(memDir: string, gitTimeoutMs: number): Promise<void> {
  const journal = await readJournal(memDir);
  if (journal !== undefined) await rollbackJournal(memDir, journal, gitTimeoutMs);
}

/** Refuse to run a transaction on a dirty .mem work tree (plan 8.2). */
async function assertClean(memDir: string, gitTimeoutMs: number): Promise<void> {
  const status = (await git(memDir, ["status", "--porcelain"], gitTimeoutMs)).trim();
  if (status.length > 0) {
    throw new GitMemoError(
      "gitmemo: .mem working tree is not clean — refusing to write. gitmemo never stashes, resets, or commits unknown changes. " +
        "Inspect with: git -C " + memDir + " status"
    );
  }
}

async function assertOnMain(memDir: string, gitTimeoutMs: number): Promise<void> {
  let sym = "";
  try {
    sym = (await git(memDir, ["symbolic-ref", "-q", "HEAD"], gitTimeoutMs)).trim();
  } catch {
    sym = "";
  }
  if (sym !== "refs/heads/main") {
    throw new GitMemoError(
      `gitmemo: .mem HEAD is not on refs/heads/main (${sym || "unborn HEAD"}) — gitmemo requires its single main branch`
    );
  }
}

/** Write/delete/replace must run on the new format; legacy repos need migration. */
async function assertNewFormat(memDir: string, gitTimeoutMs: number, root: string): Promise<void> {
  const format = await repoFormat(memDir, gitTimeoutMs);
  if (format !== "new") {
    throw new GitMemoError(
      "gitmemo: .mem exists in legacy format — write operations are disabled. " +
        `Run \`dsh-gitmemo migrate --project-root ${root} --dry-run\` to plan migration, then --apply.`
    );
  }
}

/** Current code branch + HEAD SHA for entry metadata (plan 7.2/7.3). */
async function codeContext(root: string, gitTimeoutMs: number): Promise<CodeContext> {
  try {
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], gitTimeoutMs)).trim();
    const commit = (await git(root, ["rev-parse", "HEAD"], gitTimeoutMs)).trim();
    if (branch === "HEAD") return { branch: "detached:" + commit, commit };
    return { branch: branch.length > 0 ? branch : "unknown", commit: COMMIT_RE.test(commit) ? commit : "unknown" };
  } catch {
    // Unborn HEAD (fresh repo without commits): resolve the symbolic ref directly.
    try {
      const sym = (await git(root, ["symbolic-ref", "--short", "HEAD"], gitTimeoutMs)).trim();
      if (sym.length > 0) return { branch: sym, commit: "unknown" };
    } catch {
      // not a git repo at all
    }
    return { branch: "unknown", commit: "unknown" };
  }
}

/** Verify the staged index equals exactly the transaction plan before commit. */
async function assertStagedExactly(
  memDir: string,
  expected: Array<{ status: "A" | "D"; path: string }>,
  gitTimeoutMs: number
): Promise<void> {
  const out = await git(memDir, ["diff", "--cached", "--name-status", "--no-renames"], gitTimeoutMs);
  const actual = out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
  const sorted = (list: Array<{ status: string; path: string }>) => [...list].sort((a, b) => a.path.localeCompare(b.path));
  const a = sorted(actual);
  const e = sorted(expected);
  if (a.length !== e.length || a.some((x, i) => x.status !== e[i].status || x.path !== e[i].path)) {
    throw new GitMemoError(
      "gitmemo: staged changes do not match the transaction plan — aborting before commit. Staged: " +
        JSON.stringify(actual) +
        ", planned: " +
        JSON.stringify(expected)
    );
  }
}

async function assertParentNotTracking(root: string, memDir: string, gitTimeoutMs: number): Promise<void> {
  if (!(await gitOk(root, ["rev-parse", "--git-dir"], gitTimeoutMs))) return;
  const rel = relative(root, memDir).split(sep).join("/");
  const tracked = (await git(root, ["ls-files", "--", rel], gitTimeoutMs)).trim();
  if (tracked.length > 0) {
    throw new GitMemoError(
      `gitmemo: the parent repository already tracks ${rel} — gitmemo refuses to initialize inside a tracked directory. ` +
        `Remove it from version control first (git rm -r --cached ${rel}).`
    );
  }
}

/** Add `.mem/` and the lock file path to the parent repo's info/exclude. */
async function excludeFromParent(root: string, gitTimeoutMs: number): Promise<void> {
  let gitPath = "";
  try {
    gitPath = (await git(root, ["rev-parse", "--git-path", "info/exclude"], gitTimeoutMs)).trim();
  } catch {
    return;
  }
  if (gitPath.length === 0) return;
  const excludePath = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.split("\n");
  let changed = false;
  for (const wanted of [".mem/", LOCK_FILE_NAME, MIGRATION_JOURNAL_NAME, ".mem.gitmemo-old-*", ".mem.gitmemo-tmp-*"]) {
    if (!lines.includes(wanted)) {
      lines.push(wanted);
      changed = true;
    }
  }
  if (changed) {
    await writeFile(excludePath, lines.filter((l, i) => !(i === 0 && l === "" && lines.length > 1)).join("\n") + "\n", "utf8");
  }
}

/**
 * Initialize a new-format `.mem` repo (plan 8.4): build the whole repo in a
 * sibling temp directory (init commit carries `.gitmemo-format` + `.gitkeep`
 * on `main`), then atomically rename it into place. Never converts an
 * existing legacy repo. Idempotent for already-initialized repos.
 */
export async function ensureInit(root: string, memDir: string, gitTimeoutMs: number): Promise<void> {
  await recoverMigrationSwap(root, gitTimeoutMs);
  if (await pathExists(join(memDir, ".git"))) return;
  await assertParentNotTracking(root, memDir, gitTimeoutMs);
  if (await pathExists(memDir)) {
    throw new GitMemoError(
      `gitmemo: ${memDir} exists but is not a git repository — move it away or remove it, then retry`
    );
  }
  const tmp = join(root, `.mem.gitmemo-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  await mkdir(join(tmp, ENTRY_DIR), { recursive: true });
  await gitInitMain(tmp, gitTimeoutMs);
  await writeFile(join(tmp, FORMAT_FILE), GITMEMO_FORMAT_VERSION + "\n", "utf8");
  await writeFile(join(tmp, ENTRY_DIR, ".gitkeep"), "", "utf8");
  await git(tmp, ["add", "-A", "--", FORMAT_FILE, ENTRY_DIR + "/.gitkeep"], gitTimeoutMs);
  await commitWithIdentity(tmp, "init: initialize memory repo (gitmemo format 2)", gitTimeoutMs);
  await rename(tmp, memDir);
  await excludeFromParent(root, gitTimeoutMs);
}

// ---------------------------------------------------------------------------
// in-process search cache (plan 6.7)
// ---------------------------------------------------------------------------

interface SearchComputation {
  hits: SearchHit[];
  diagnostics: string[];
}

const searchCache = new Map<string, SearchComputation>();

function cacheSearch(key: string, value: SearchComputation): void {
  searchCache.delete(key);
  searchCache.set(key, value);
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// GitMemo engine
// ---------------------------------------------------------------------------

/**
 * Git-backed long-term memory engine operating on one project root.
 * Every operation auto-initializes a new-format repo; legacy repos are
 * read-only for search/read until migrated via the CLI.
 */
export class GitMemo {
  readonly root: string;
  readonly memDir: string;
  private readonly config: Required<Pick<GitMemoConfig, "searchLimit" | "gitTimeoutMs" | "lockTimeoutMs">>;

  constructor(root: string, config: GitMemoConfig = {}) {
    this.root = resolve(root);
    const positiveInt = (value: number | undefined, fallback: number, name: string): number => {
      if (value === undefined) return fallback;
      if (!Number.isInteger(value) || value <= 0) {
        throw new GitMemoError(`gitmemo: ${name} must be a positive integer`);
      }
      return value;
    };
    this.config = {
      searchLimit: positiveInt(config.searchLimit, 20, "searchLimit"),
      gitTimeoutMs: positiveInt(config.gitTimeoutMs, 60000, "gitTimeoutMs"),
      lockTimeoutMs: positiveInt(config.lockTimeoutMs, 30000, "lockTimeoutMs")
    };
    this.memDir = join(this.root, ".mem");
  }

  /** Initialize the memory repo when missing (idempotent). */
  async init(): Promise<string> {
    await withLock(this.root, this.config, "init", async () => {
      await ensureInit(this.root, this.memDir, this.config.gitTimeoutMs);
    });
    return this.memDir;
  }

  /**
   * Search past memories (plan 6): fixed-string OR grep recall over commit
   * messages only, active-entry filtering, field-level matching and scoring,
   * snapshot-stable pagination, in-process LRU.
   *
   * @param keywords - 1-12 keywords (legacy callers may pass a comma-separated string).
   * @param options.skip - pagination offset.
   * @param options.snapshot - pass back the snapshot from the first page.
   */
  async search(keywords: string[] | string, options: SearchOptions = {}): Promise<SearchOutput> {
    let normalized: string[];
    let adapterWarning: string | undefined;
    if (typeof keywords === "string") {
      normalized = keywords
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .map((k) => normalizeKeyword(k));
      adapterWarning = "gitmemo: deprecation — mem_search.keywords as a comma-separated string; pass an array of 1-12 keywords";
    } else {
      if (!Array.isArray(keywords)) throw new GitMemoError("gitmemo: search keywords must be an array");
      normalized = keywords.map((k) => normalizeKeyword(k));
    }
    normalized = dedupe(normalized);
    if (options.mode !== undefined) {
      adapterWarning = (adapterWarning ? adapterWarning + " " : "") +
        "gitmemo: deprecation — mem_search.mode is gone; recall is always OR";
    }
    if (normalized.length < 1 || normalized.length > 12) {
      throw new GitMemoError("gitmemo: search requires 1-12 non-empty keywords");
    }
    const skip = options.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0) throw new GitMemoError("gitmemo: skip must be a non-negative integer");
    const limit = this.config.searchLimit;
    const requestedSnapshot =
      typeof options.snapshot === "string" && options.snapshot.trim().length > 0
        ? options.snapshot.trim()
        : undefined;

    // Read barrier: resolve the immutable snapshot under the lock (creating
    // the repo when missing), then scan without holding it.
    const { snapshot, legacy, warning } = await withLock(this.root, this.config, "search", async () => {
      if (!(await pathExists(join(this.memDir, ".git")))) {
        await ensureInit(this.root, this.memDir, this.config.gitTimeoutMs);
      }
      return resolveSnapshot(this.memDir, this.config.gitTimeoutMs, this.root, requestedSnapshot);
    });

    const cacheKey = this.memDir + "\x00" + snapshot + "\x00" + normalized.join("\x00");
    let computation = searchCache.get(cacheKey);
    if (computation === undefined) {
      computation = await this.computeSearch(snapshot, normalized, legacy);
      cacheSearch(cacheKey, computation);
    }

    const total = computation.hits.length;
    const next_skip = skip + limit < total ? skip + limit : null;
    const allWarnings = [adapterWarning, warning].filter((w) => w !== undefined).join(" ");
    return {
      snapshot,
      total,
      next_skip,
      results: computation.hits.slice(skip, skip + limit),
      ...(legacy ? { legacy: true } : {}),
      ...(allWarnings.length > 0 ? { warning: allWarnings } : {}),
      ...(computation.diagnostics.length > 0 ? { diagnostics: computation.diagnostics } : {})
    };
  }

  private async computeSearch(snapshot: string, kws: string[], legacy: boolean): Promise<SearchComputation> {
    // New-format entries are immutable, so candidate commit + active ls-tree
    // is sufficient and keeps the normal search path to one grep log. Legacy
    // repos may have in-place edits and need a full-history claimed map.
    const legacySnapshot = legacy ? await activeSnapshot(this.memDir, snapshot, this.config.gitTimeoutMs) : undefined;
    const active = legacySnapshot?.active ?? new Set(
      (await git(
        this.memDir,
        ["ls-tree", "-r", "--name-only", snapshot, "--", ENTRY_DIR + "/"],
        this.config.gitTimeoutMs
      )).split("\n").filter((line) => line.length > 0)
    );
    const grepArgs = ["log", snapshot, "--fixed-strings"];
    for (const kw of kws) grepArgs.push("--grep=" + kw);
    grepArgs.push(
      "--format=%x00%H%x00%ct%x00%s%x00%B%x00",
      "--name-status",
      "--no-renames",
      "--",
      ENTRY_DIR + "/"
    );
    const output = await git(this.memDir, grepArgs, this.config.gitTimeoutMs);
    const candidates = parseLogRecords(output);
    const hits: SearchHit[] = [];
    const diagnostics: string[] = [...(legacySnapshot?.diagnostics ?? [])];
    const seenFiles = new Set<string>();
    for (const record of candidates) {
      if (record.added.length !== 1) {
        if (record.added.length > 1) diagnostics.push(`commit ${record.hash} adds ${record.added.length} entries; skipped`);
        continue;
      }
      const file = record.added[0];
      if (!active.has(file)) continue;
      if (legacy && legacySnapshot?.claimed.get(file)?.hash !== record.hash) continue;
      if (seenFiles.has(file)) {
        diagnostics.push(`multiple matching commits claim active entry ${file}; older candidate ${record.hash} skipped`);
        continue;
      }
      seenFiles.add(file);
      if (!legacy && record.message.type !== "add" && record.message.type !== "replace") continue;
      const fields = [record.message.subject, record.message.summary, ...record.message.keywords].map((f) => normalizeText(f));
      const matched: string[] = [];
      for (const kw of kws) {
        if (fields.some((field) => field.includes(kw))) matched.push(kw);
      }
      if (matched.length === 0) continue;
      hits.push({
        hash: record.hash,
        title: record.message.subject,
        date: safeIsoDate(record.committerTime),
        summary: record.message.summary,
        keywords: record.message.keywords,
        score: matched.length,
        matched_keywords: matched
      });
    }
    // plan 6.6: score desc, committer time desc, full hash desc (deterministic)
    hits.sort(
      (a, b) => b.score - a.score || b.date.localeCompare(a.date) || (a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0)
    );
    return { hits, diagnostics };
  }

  /**
   * Read one memory entry by create/replace commit hash. Historical entries
   * (deleted or replaced) stay readable for audit; `mem_read` accepts legacy
   * hashes too.
   */
  async read(commitHash: string): Promise<ReadResult> {
    if (!/^[0-9a-f]{7,64}$/.test(commitHash)) throw new GitMemoError("gitmemo: read requires a commit hash");
    return withLock(this.root, this.config, "read", async () => {
      if (!(await pathExists(join(this.memDir, ".git")))) {
        await ensureInit(this.root, this.memDir, this.config.gitTimeoutMs);
      }
      const full = await resolveCommit(this.memDir, commitHash, this.config.gitTimeoutMs);
      const added = await addedFilesOf(this.memDir, full, this.config.gitTimeoutMs);
      if (added.length !== 1) {
        throw new GitMemoError("gitmemo: no entry file found in commit " + full);
      }
      const content = await git(this.memDir, ["show", full + ":" + added[0]], this.config.gitTimeoutMs);
      const body = await git(this.memDir, ["log", "-1", "--format=%B", full], this.config.gitTimeoutMs);
      const message = parseCommitMessage(body);
      const legacy = message.type === "unknown";
      return { hash: full, file: added[0], content, ...(legacy ? { legacy: true } : {}) };
    });
  }

  /**
   * Write a memory entry (plan 5.3). Entries are immutable: each write
   * creates a brand-new file `entries/<utc-ms>-<digest-prefix>-<slug>.md`
   * with one ADD commit. `legacy = true` relaxes the keyword minimum to 0
   * (compatibility adapter + migration reimports).
   */
  async write(input: WriteInput | LegacyWriteInput, legacy = false): Promise<WriteResult> {
    const adapted = legacy ? await adaptLegacyWriteInput(input) : input as WriteInput;
    const validated = validateWriteInput(adapted, legacy);
    const digest = computeDigest(validated.title, validated.summary, validated.keywords, validated.content);
    return withLock(this.root, this.config, "write", async () => {
      await ensureInit(this.root, this.memDir, this.config.gitTimeoutMs);
      await assertNewFormat(this.memDir, this.config.gitTimeoutMs, this.root);
      await recoverJournal(this.memDir, this.config.gitTimeoutMs);
      await assertClean(this.memDir, this.config.gitTimeoutMs);
      await assertOnMain(this.memDir, this.config.gitTimeoutMs);
      const ctx = await codeContext(this.root, this.config.gitTimeoutMs);
      const baseHead = (await git(this.memDir, ["rev-parse", "HEAD"], this.config.gitTimeoutMs)).trim();
      const { active, records, claimed } = await activeSnapshot(this.memDir, baseHead, this.config.gitTimeoutMs);
      void active;
      for (const entry of claimed.values()) {
        if (entry.digest === digest) {
          throw new GitMemoError(
            "gitmemo: an active entry with the same digest already exists (identical title/summary/keywords/content) — " +
              "use mem_replace to update it, or mem_delete then write again"
          );
        }
      }
      const relatedBranches = dedupe([...validated.related_branches, ctx.branch]);
      const markdown = buildEntryMarkdown(
        { ...validated, related_branches: relatedBranches },
        { ...ctx, relatedBranches },
        digest,
        new Date()
      );
      const baseName = utcMs(new Date()) + "-" + digest.slice(0, 8) + "-" + slugifyTitle(validated.title) + ".md";
      const { file, journal } = await createJournaledEntryFile(this.memDir, baseName, markdown, (entryFile) => ({
        operationId: randomUUID(),
        operation: "write",
        phase: "prepared",
        baseHead,
        add: [entryFile],
        delete: [],
        digest,
        createdAt: new Date().toISOString()
      }));
      try {
        await git(this.memDir, ["add", "--", file], this.config.gitTimeoutMs);
        await assertStagedExactly(this.memDir, [{ status: "A", path: file }], this.config.gitTimeoutMs);
        const hash = await commitWithIdentity(
          this.memDir,
          buildAddMessage(validated.title, validated.summary, validated.keywords, digest, legacy),
          this.config.gitTimeoutMs
        );
        await rm(journalPath(this.memDir), { force: true });
        return { hash, file, ...(legacy ? { legacy: true } : {}) };
      } catch (error) {
        try {
          await rollbackJournal(this.memDir, journal, this.config.gitTimeoutMs);
        } catch (rollbackError) {
          throw new GitMemoError(String(error) + " — additionally, automatic rollback failed: " + String(rollbackError));
        }
        throw error;
      }
    });
  }

  /**
   * Delete a memory entry (plan 5.4). Only withdraws the ACTIVE entry of a
   * create/replace hash; stale hashes are rejected.
   */
  async delete(input: DeleteInput): Promise<{ file: string }> {
    if (!/^[0-9a-f]{7,64}$/.test(input.commit_hash)) throw new GitMemoError("gitmemo: delete requires a commit hash");
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new GitMemoError("gitmemo: delete requires a reason");
    }
    const reason = input.reason.trim();
    if (reason.length > 4000) throw new GitMemoError("gitmemo: delete reason must be at most 4000 characters");
    assertNoControlChars(reason, "reason");
    assertNoTrailerInjection(reason, "reason");
    return withLock(this.root, this.config, "delete", async () => {
      await ensureInit(this.root, this.memDir, this.config.gitTimeoutMs);
      await assertNewFormat(this.memDir, this.config.gitTimeoutMs, this.root);
      await recoverJournal(this.memDir, this.config.gitTimeoutMs);
      await assertClean(this.memDir, this.config.gitTimeoutMs);
      await assertOnMain(this.memDir, this.config.gitTimeoutMs);
      const baseHead = (await git(this.memDir, ["rev-parse", "HEAD"], this.config.gitTimeoutMs)).trim();
      const full = await resolveCommit(this.memDir, input.commit_hash, this.config.gitTimeoutMs);
      const { file } = await activeEntryForHash(this.memDir, full, baseHead, this.config.gitTimeoutMs);
      const journal: TransactionJournal = {
        operationId: randomUUID(),
        operation: "delete",
        phase: "prepared",
        baseHead,
        add: [],
        delete: [file],
        createdAt: new Date().toISOString()
      };
      await writeJournal(this.memDir, journal);
      try {
        await git(this.memDir, ["rm", "-q", "--", file], this.config.gitTimeoutMs);
        await assertStagedExactly(this.memDir, [{ status: "D", path: file }], this.config.gitTimeoutMs);
        await commitWithIdentity(
          this.memDir,
          buildDeleteMessage(basename(file, ".md"), reason, full),
          this.config.gitTimeoutMs
        );
        await rm(journalPath(this.memDir), { force: true });
        return { file };
      } catch (error) {
        try {
          await rollbackJournal(this.memDir, journal, this.config.gitTimeoutMs);
        } catch (rollbackError) {
          throw new GitMemoError(String(error) + " — additionally, automatic rollback failed: " + String(rollbackError));
        }
        throw error;
      }
    });
  }

  /**
   * Replace an active entry (plan 5.5): one transaction, one commit deletes
   * the old file and adds the new one (never delete-then-write). The active
   * digest dedupe excludes the entry being replaced, so replacing with the
   * same digest but updated non-digest metadata (related branches/paths) is
   * legal; colliding with any OTHER active entry is rejected.
   */
  async replace(input: ReplaceInput): Promise<WriteResult> {
    const validated = validateWriteInput(input);
    const digest = computeDigest(validated.title, validated.summary, validated.keywords, validated.content);
    return withLock(this.root, this.config, "replace", async () => {
      await ensureInit(this.root, this.memDir, this.config.gitTimeoutMs);
      await assertNewFormat(this.memDir, this.config.gitTimeoutMs, this.root);
      await recoverJournal(this.memDir, this.config.gitTimeoutMs);
      await assertClean(this.memDir, this.config.gitTimeoutMs);
      await assertOnMain(this.memDir, this.config.gitTimeoutMs);
      const ctx = await codeContext(this.root, this.config.gitTimeoutMs);
      const baseHead = (await git(this.memDir, ["rev-parse", "HEAD"], this.config.gitTimeoutMs)).trim();
      const full = await resolveCommit(this.memDir, input.commit_hash, this.config.gitTimeoutMs);
      const { file: oldFile } = await activeEntryForHash(this.memDir, full, baseHead, this.config.gitTimeoutMs);
      const { active, records, claimed } = await activeSnapshot(this.memDir, baseHead, this.config.gitTimeoutMs);
      void active;
      for (const [file, entry] of claimed) {
        if (file === oldFile) continue; // replacing entry excluded from dedupe
        if (entry.digest === digest) {
          throw new GitMemoError(
            "gitmemo: another active entry uses the same digest (identical title/summary/keywords/content) — " +
              "mem_replace would create an exact duplicate"
          );
        }
      }
      const relatedBranches = dedupe([...validated.related_branches, ctx.branch]);
      const markdown = buildEntryMarkdown(
        { ...validated, related_branches: relatedBranches },
        { ...ctx, relatedBranches },
        digest,
        new Date()
      );
      const baseName = utcMs(new Date()) + "-" + digest.slice(0, 8) + "-" + slugifyTitle(validated.title) + ".md";
      const { file: newFile, journal } = await createJournaledEntryFile(this.memDir, baseName, markdown, (entryFile) => ({
        operationId: randomUUID(),
        operation: "replace",
        phase: "prepared",
        baseHead,
        add: [entryFile],
        delete: [oldFile],
        digest,
        createdAt: new Date().toISOString()
      }));
      try {
        await rm(join(this.memDir, oldFile), { force: true });
        await git(this.memDir, ["add", "-A", "--", oldFile, newFile], this.config.gitTimeoutMs);
        await assertStagedExactly(
          this.memDir,
          [
            { status: "D", path: oldFile },
            { status: "A", path: newFile }
          ],
          this.config.gitTimeoutMs
        );
        const hash = await commitWithIdentity(
          this.memDir,
          buildReplaceMessage(validated.title, validated.summary, validated.keywords, digest, full),
          this.config.gitTimeoutMs
        );
        await rm(journalPath(this.memDir), { force: true });
        return { hash, file: newFile };
      } catch (error) {
        try {
          await rollbackJournal(this.memDir, journal, this.config.gitTimeoutMs);
        } catch (rollbackError) {
          throw new GitMemoError(String(error) + " — additionally, automatic rollback failed: " + String(rollbackError));
        }
        throw error;
      }
    });
  }
}
