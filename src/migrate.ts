/**
 * Legacy → new-format migration for dsh-gitmemo (plan 10).
 *
 * Legacy `.mem` repos (no `.gitmemo-format` marker, possibly multi-branch)
 * are migrated fully automatically by the engine: the first operation on a
 * legacy repo runs dry-run + apply in one step (no `dsh-gitmemo` command
 * needed). The CLI (`dsh-gitmemo migrate --project-root <path>
 * --dry-run|--apply`) remains for explicit control — non-default --source
 * directories, baseline review, and repos where automatic migration is
 * blocked (conflicts, dirty worktree, ...).
 *
 * Apply mechanics:
 *  1. backup refs for every old branch tip (`refs/gitmemo/backup/<ts>/<b>`);
 *  2. a brand-new canonical `main` is built in a sibling temp repo (init
 *     commit + one immutable ADD commit per unique active entry);
 *  3. old objects are fetched into the new repo (backup refs keep old hashes
 *     readable forever), then the directory is swapped atomically;
 *  4. on any failure the original `.mem` is left untouched.
 *
 * Metadata inference is deterministic and offline (plan 10.6): keywords come
 * from the old front matter `tags/keywords` (else explicit keyword lines in
 * the old commit body), summary from the first `Final Outcome` paragraph
 * (else the old commit body). Nothing is fabricated.
 *
 * @module dsh-gitmemo/migrate
 */
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  ENTRY_DIR,
  FORMAT_FILE,
  GITMEMO_FORMAT_VERSION,
  GitMemoError,
  LOCK_FILE_NAME,
  MIGRATION_JOURNAL_NAME,
  buildAddMessage,
  buildEntryMarkdown,
  computeDigest,
  createEntryFile,
  git,
  gitInitMain,
  normalizeText,
  repoFormat,
  resolveCommit,
  recoverMigrationSwap,
  slugifyTitle,
  commitWithIdentity,
  utcMs,
  withLock,
  writeMigrationSwapJournal,
  type MigrationSwapJournal
} from "./mem.js";

function safeLegacyDate(epochRaw: string | number | undefined): Date {
  const ms = Number(epochRaw ?? 0) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms) : new Date(0);
}

/** One deduplicated entry planned for reimport. */
export interface MigrationPlanEntry {
  title: string;
  summary: string;
  keywords: string[];
  content: string;
  date: string;
  codeBranch: string;
  codeCommit: string;
  relatedBranches: string[];
  relatedPaths: string[];
  digest: string;
  sourceBranch: string;
  sourcePath: string;
}

/** Same entry path with different content across branch tips. */
export interface MigrationConflict {
  path: string;
  variants: Array<{ branch: string; hash: string; digest: string }>;
}

/** Serializable baseline produced by dry-run and consumed by apply. */
export interface MigrationBaseline {
  format: "dsh-gitmemo-migration-baseline";
  version: 1;
  root: string;
  memDir: string;
  scannedAt: string;
  tips: Record<string, string>;
  entries: MigrationPlanEntry[];
  conflicts: MigrationConflict[];
  warnings: string[];
}

export interface MigrationDryRunReport {
  legacy: boolean;
  alreadyNewFormat?: boolean;
  branches: string[];
  tips: Record<string, string>;
  oldEntryCount: number;
  uniqueEntryCount: number;
  conflictCount: number;
  estimatedMainCommits: number;
  baseline: MigrationBaseline;
  warnings: string[];
}

export interface MigrationApplyReport {
  migrated: boolean;
  alreadyMigrated?: boolean;
  entries: number;
  newMain: string;
  backupRefPrefix: string;
  oldBranches: string[];
}

export interface MigrationOptions {
  /** Legacy memory dir to migrate from (default `<root>/.mem`). */
  source?: string;
  gitTimeoutMs?: number;
  lockTimeoutMs?: number;
}

/** Why automatic migration could not run (user-resolvable blocking conditions). */
export interface AutoMigrateBlock {
  code: "no-repo" | "no-branches" | "conflicts" | "dirty" | "legacy-journal" | "other";
  /** Human-readable detail; safe to surface to the user. */
  detail: string;
}

/** Outcome of an automatic migration attempt (never throws for blocking conditions). */
export interface AutoMigrateOutcome {
  migrated: boolean;
  alreadyNewFormat?: boolean;
  blocked?: AutoMigrateBlock;
  report?: MigrationApplyReport;
}

async function isGitRepo(dir: string, gitTimeoutMs: number): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--git-dir"], gitTimeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function listTips(memDir: string, gitTimeoutMs: number): Promise<{ branches: string[]; tips: Record<string, string> }> {
  const out = (await git(memDir, ["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads"], gitTimeoutMs)).trim();
  const branches: string[] = [];
  const tips: Record<string, string> = {};
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const [branch, hash] = line.split("\t");
    branches.push(branch);
    tips[branch] = hash;
  }
  return { branches, tips };
}

// ---------------------------------------------------------------------------
// legacy metadata inference (deterministic, offline)
// ---------------------------------------------------------------------------

function frontMatterBlock(content: string): string[] {
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return [];
  const block: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") break;
    block.push(lines[i]);
  }
  return block;
}

function legacyFrontMatterKeywords(content: string): string[] {
  const block = frontMatterBlock(content);
  const out: string[] = [];
  for (let i = 0; i < block.length; i += 1) {
    const match = /^(tags|keywords)\s*:\s*(.*)$/.exec(block[i]);
    if (match === null) continue;
    let value = match[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
    out.push(
      ...value
        .split(/[,，]/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0)
    );
    for (let k = i + 1; k < block.length; k += 1) {
      const item = /^\s*-\s*(.+)$/.exec(block[k]);
      if (item === null) break;
      out.push(item[1].trim());
    }
  }
  return out;
}

/** Explicit `keywords:`/`tags:` lines in an old commit body (list-like values only). */
function legacyBodyKeywords(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^(keywords?|tags?)\s*[:：]\s*(.+)$/i.exec(line.trim());
    if (match === null) continue;
    if (!/[,，]/.test(match[2])) continue; // only accept list-like values
    out.push(
      ...match[2]
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    );
  }
  return out;
}

/** First paragraph after a `## Final Outcome`-style heading. */
function finalOutcomeParagraph(content: string): string {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{1,6}\s*Final Outcome\s*$/i.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const paragraph: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    paragraph.push(line);
  }
  return paragraph.join(" ").trim();
}

function inferLegacyMetadata(
  content: string,
  subject: string,
  body: string
): { title: string; summary: string; keywords: string[]; warnings: string[] } {
  const warnings: string[] = [];
  let title = subject.replace(/\s+/g, " ").trim().slice(0, 200);
  if (title.length === 0) {
    title = "legacy memory";
    warnings.push("entry with empty subject — titled 'legacy memory'");
  }
  let keywords = legacyFrontMatterKeywords(content);
  if (keywords.length === 0) keywords = legacyBodyKeywords(body);
  const safeKeywords: string[] = [];
  const seenKeywords = new Set<string>();
  for (const original of keywords) {
    const cleaned = original
      .normalize("NFKC")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length === 0) {
      warnings.push("discarded an empty/unsafe legacy keyword");
      continue;
    }
    const bounded = cleaned.slice(0, 64);
    if (bounded !== original.trim()) warnings.push(`sanitized legacy keyword: ${JSON.stringify(original)}`);
    const normalized = normalizeText(bounded);
    if (seenKeywords.has(normalized)) continue;
    seenKeywords.add(normalized);
    safeKeywords.push(bounded);
    if (safeKeywords.length === 12) break;
  }
  keywords = safeKeywords;
  if (keywords.length === 0) warnings.push("no keywords could be inferred deterministically (legacy entries allow 0-12)");
  let summary = finalOutcomeParagraph(content);
  if (summary.length === 0) summary = body.replace(/\n{3,}/g, "\n\n").trim();
  summary = summary.slice(0, 4000);
  if (summary.length === 0) warnings.push("no summary could be inferred");
  return { title, summary, keywords, warnings };
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

async function buildPlanEntry(args: {
  memDir: string;
  gitTimeoutMs: number;
  branch: string;
  file: string;
  content: string;
  hash: string;
  date: Date;
  subject: string;
  body: string;
  warnings: string[];
}): Promise<MigrationPlanEntry> {
  const meta = inferLegacyMetadata(args.content, args.subject, args.body);
  args.warnings.push(...meta.warnings.map((w) => `${args.branch}:${args.file}: ${w}`));
  const date = args.date.toISOString();
  return {
    title: meta.title,
    summary: meta.summary,
    keywords: meta.keywords,
    content: args.content,
    date,
    codeBranch: args.branch,
    codeCommit: args.hash,
    relatedBranches: [args.branch],
    relatedPaths: ["entries/" + basename(args.file)],
    digest: computeDigest(meta.title, meta.summary, meta.keywords, args.content),
    sourceBranch: args.branch,
    sourcePath: args.file
  };
}

/**
 * Scan a legacy `.mem` repo and produce the migration plan. Read-only: no
 * ref, index or worktree state is modified (the lock file is transient).
 */
export async function migrateDryRun(root: string, options: MigrationOptions = {}): Promise<MigrationDryRunReport> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 30000;
  return withLock(root, { lockTimeoutMs }, "migrate-dry-run", () => migrateDryRunUnlocked(root, options));
}

/** Unlocked core of {@link migrateDryRun}; the caller must hold the cross-process lock. */
async function migrateDryRunUnlocked(root: string, options: MigrationOptions = {}): Promise<MigrationDryRunReport> {
  const gitTimeoutMs = options.gitTimeoutMs ?? 60000;
  const memDir = resolve(options.source ?? join(root, ".mem"));
  try {
    await git(memDir, ["rev-parse", "--git-dir"], gitTimeoutMs);
  } catch {
    throw new GitMemoError("gitmemo: no .mem repository at " + memDir);
  }
    if ((await repoFormat(memDir, gitTimeoutMs)) === "new") {
      return {
        legacy: false,
        alreadyNewFormat: true,
        branches: [],
        tips: {},
        oldEntryCount: 0,
        uniqueEntryCount: 0,
        conflictCount: 0,
        estimatedMainCommits: 0,
        baseline: {
          format: "dsh-gitmemo-migration-baseline",
          version: 1,
          root: resolve(root),
          memDir,
          scannedAt: new Date().toISOString(),
          tips: {},
          entries: [],
          conflicts: [],
          warnings: []
        },
        warnings: ["already in new format — nothing to migrate"]
      };
    }
    const { branches, tips } = await listTips(memDir, gitTimeoutMs);
    if (branches.length === 0) {
      throw new GitMemoError("gitmemo: legacy .mem has no branches — nothing to migrate");
    }
    const warnings: string[] = [];
    const variantsByPath = new Map<string, Map<string, { branch: string; hash: string; digest: string }>>();
    const occurrences = new Map<string, Set<string>>(); // content digest -> paths
    const byDigest = new Map<string, MigrationPlanEntry>();
    let oldEntryCount = 0;
    for (const branch of branches.sort()) {
      const tip = tips[branch];
      const filesOut = (await git(memDir, ["ls-tree", "-r", "--name-only", tip, "--", ENTRY_DIR + "/"], gitTimeoutMs)).trim();
      const files = filesOut.split("\n").filter((line) => line.startsWith(ENTRY_DIR + "/") && line.endsWith(".md"));
      for (const file of files.sort()) {
        oldEntryCount += 1;
        const content = await git(memDir, ["show", tip + ":" + file], gitTimeoutMs);
        const createOut = (await git(memDir, ["log", "-1", "--format=%ct%x00%H%x00%s%x00%B", tip, "--", file], gitTimeoutMs)).trim();
        const [ctRaw, hash, subject, body] = createOut.split("\x00");
        const contentDigest = createHash("sha256").update(content, "utf8").digest("hex");
        let pathVariants = variantsByPath.get(file);
        if (pathVariants === undefined) {
          pathVariants = new Map();
          variantsByPath.set(file, pathVariants);
        }
        pathVariants.set(branch, { branch, hash, digest: contentDigest });
        let paths = occurrences.get(contentDigest);
        if (paths === undefined) {
          paths = new Set();
          occurrences.set(contentDigest, paths);
        }
        paths.add(file);
        if (!byDigest.has(contentDigest)) {
          const plan = await buildPlanEntry({
            memDir,
            gitTimeoutMs,
            branch,
            file,
            content,
            hash,
            date: safeLegacyDate(ctRaw),
            subject: subject ?? "",
            body: body ?? "",
            warnings
          });
          byDigest.set(contentDigest, plan);
        }
      }
    }
    // conflicts: same path, different content
    const conflicts: MigrationConflict[] = [];
    for (const [path, variants] of variantsByPath) {
      const digests = new Set([...variants.values()].map((v) => v.digest));
      if (digests.size > 1) {
        conflicts.push({
          path,
          variants: [...variants.values()].sort((a, b) => a.branch.localeCompare(b.branch))
        });
      }
    }
    // a content digest that occurs at a conflicted path is excluded from auto-migration
    const conflictedPaths = new Set(conflicts.map((c) => c.path));
    const conflictedDigests = new Set<string>();
    for (const [digest, paths] of occurrences) {
      for (const path of paths) {
        if (conflictedPaths.has(path)) conflictedDigests.add(digest);
      }
    }
    // NOTE: byDigest is keyed by the raw content digest (sha256 of content);
    // the plan's `digest` field is the new canonical engine digest — filter by key.
    const entries = [...byDigest.entries()]
      .filter(([contentDigest]) => !conflictedDigests.has(contentDigest))
      .map(([, plan]) => plan);
    const baseline: MigrationBaseline = {
      format: "dsh-gitmemo-migration-baseline",
      version: 1,
      root: resolve(root),
      memDir,
      scannedAt: new Date().toISOString(),
      tips,
      entries,
      conflicts,
      warnings
    };
    return {
      legacy: true,
      branches,
      tips,
      oldEntryCount,
      uniqueEntryCount: entries.length,
      conflictCount: conflicts.length,
      estimatedMainCommits: 1 + entries.length,
      baseline,
      warnings
    };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function conflictManifest(conflicts: MigrationConflict[]): string {
  return conflicts
    .map((c) => {
      const variants = c.variants.map((v) => `${v.branch}@${v.hash.slice(0, 12)}`).join(", ");
      return `  ${c.path}: [${variants}]`;
    })
    .join("\n");
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
 * Execute a previously dry-run migration (plan 10.4). Verifies the baseline
 * refs are unchanged, blocks on conflicts, creates backup refs, builds the
 * new canonical main in a temp repo, then swaps directories atomically.
 */
export async function migrateApply(root: string, baseline: MigrationBaseline, options: MigrationOptions = {}): Promise<MigrationApplyReport> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 30000;
  return withLock(root, { lockTimeoutMs }, "migrate", () => migrateApplyUnlocked(root, baseline, options));
}

/** Unlocked core of {@link migrateApply}; the caller must hold the cross-process lock. */
async function migrateApplyUnlocked(root: string, baseline: MigrationBaseline, options: MigrationOptions = {}): Promise<MigrationApplyReport> {
  const gitTimeoutMs = options.gitTimeoutMs ?? 60000;
  if (
    baseline === null ||
    typeof baseline !== "object" ||
    baseline.format !== "dsh-gitmemo-migration-baseline" ||
    baseline.version !== 1 ||
    typeof baseline.root !== "string" ||
    baseline.root.length === 0 ||
    typeof baseline.memDir !== "string" ||
    baseline.memDir.length === 0 ||
    baseline.tips === null ||
    typeof baseline.tips !== "object" ||
    Array.isArray(baseline.tips) ||
    !Array.isArray(baseline.entries) ||
    !Array.isArray(baseline.conflicts) ||
    !Array.isArray(baseline.warnings)
  ) {
    throw new GitMemoError("gitmemo: invalid migration baseline — re-run `dsh-gitmemo migrate --dry-run`");
  }
  if (resolve(baseline.root) !== resolve(root)) {
    throw new GitMemoError(
      `gitmemo: migration baseline belongs to a different project root (${baseline.root}); re-run --dry-run for ${resolve(root)}`
    );
  }
  const memDir = resolve(options.source ?? baseline.memDir ?? join(root, ".mem"));
  if (resolve(baseline.memDir) !== memDir) {
    throw new GitMemoError("gitmemo: migration baseline source path is inconsistent — re-run --dry-run");
  }
  await recoverMigrationSwap(root, gitTimeoutMs);
    if ((await repoFormat(memDir, gitTimeoutMs)) === "new") {
      return { migrated: false, alreadyMigrated: true, entries: 0, newMain: "", backupRefPrefix: "", oldBranches: [] };
    }
    // 1. re-verify the dry-run baseline refs are unchanged
    const current = await listTips(memDir, gitTimeoutMs);
    const baselineBranches = Object.keys(baseline.tips).sort();
    if (baselineBranches.length === 0) {
      throw new GitMemoError("gitmemo: baseline contains no branches — re-run `dsh-gitmemo migrate --dry-run`");
    }
    for (const branch of baselineBranches) {
      if (current.tips[branch] !== baseline.tips[branch]) {
        throw new GitMemoError(
          `gitmemo: branch "${branch}" changed since the dry-run baseline (${current.tips[branch] ?? "gone"} ≠ ${baseline.tips[branch]}) — re-run --dry-run`
        );
      }
    }
    if (current.branches.length !== baselineBranches.length) {
      throw new GitMemoError(
        "gitmemo: branch set changed since the dry-run baseline — re-run --dry-run"
      );
    }
    // 2. conflicts must be resolved by the user first
    if (baseline.conflicts.length > 0) {
      throw new GitMemoError(
        `gitmemo: migration blocked by ${baseline.conflicts.length} conflict(s) (same entry path, different content across branches):\n` +
          conflictManifest(baseline.conflicts) +
          "\nResolve the conflicts, then re-run --dry-run to produce a clean baseline."
      );
    }
    const legacyStatus = (await git(memDir, ["status", "--porcelain"], gitTimeoutMs)).trim();
    if (legacyStatus.length > 0) {
      throw new GitMemoError(
        "gitmemo: legacy memory repository is not clean — migration refuses to discard uncommitted/staged content. " +
          `Inspect with: git -C ${memDir} status`
      );
    }
    const legacyJournal = join(memDir, ".git", "gitmemo-transaction.json");
    try {
      await readFile(legacyJournal, "utf8");
      throw new GitMemoError(
        `gitmemo: legacy repository contains an interrupted transaction journal (${legacyJournal}); repair it before migration`
      );
    } catch (error) {
      if (error instanceof GitMemoError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // 3. backup refs in the old repo (safety net; also fetched into the new repo)
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    for (const [branch, hash] of Object.entries(baseline.tips)) {
      await git(memDir, ["update-ref", `refs/gitmemo/backup/${ts}/${branch}`, hash], gitTimeoutMs);
    }
    // 4. build the new canonical main in a sibling temp repo
    const tmp = join(root, `.mem.gitmemo-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await mkdir(join(tmp, ENTRY_DIR), { recursive: true });
      await gitInitMain(tmp, gitTimeoutMs);
      await writeFile(join(tmp, FORMAT_FILE), GITMEMO_FORMAT_VERSION + "\n", "utf8");
      await writeFile(join(tmp, ENTRY_DIR, ".gitkeep"), "", "utf8");
      await git(tmp, ["add", "-A", "--", FORMAT_FILE, ENTRY_DIR + "/.gitkeep"], gitTimeoutMs);
      await commitWithIdentity(tmp, "init: initialize memory repo (gitmemo format 2)", gitTimeoutMs);
      // fetch old objects + backup refs into the new repo so old hashes stay readable
      await git(
        tmp,
        ["fetch", "-q", memDir, `+refs/heads/*:refs/gitmemo/backup/${ts}/*`],
        gitTimeoutMs
      );
      // 5. one immutable ADD commit per unique entry, preserving old dates
      const entries = [...baseline.entries].sort(
        (a, b) => a.date.localeCompare(b.date) || a.sourcePath.localeCompare(b.sourcePath)
      );
      const digests = new Set(entries.map((e) => e.digest));
      if (digests.size !== entries.length) {
        throw new GitMemoError("gitmemo: migration plan contains duplicate digests — re-run --dry-run");
      }
      const created: Array<{ file: string; hash: string }> = [];
      for (const entry of entries) {
        const parsedMs = Date.parse(entry.date);
        const epoch = Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : 0;
        const env = { GIT_AUTHOR_DATE: "@" + epoch, GIT_COMMITTER_DATE: "@" + epoch };
        const entryDate = safeLegacyDate(epoch);
        const baseName = utcMs(entryDate) + "-" + entry.digest.slice(0, 8) + "-" + slugifyTitle(entry.title) + ".md";
        const markdown = buildEntryMarkdown(
          {
            title: entry.title,
            summary: entry.summary,
            keywords: entry.keywords,
            content: entry.content,
            related_branches: entry.relatedBranches,
            related_paths: entry.relatedPaths
          },
          { branch: entry.codeBranch, commit: entry.codeCommit, relatedBranches: entry.relatedBranches },
          entry.digest,
          entryDate
        );
        const file = await createEntryFile(tmp, baseName, markdown);
        await git(tmp, ["add", "--", file], gitTimeoutMs);
        const hash = await commitWithIdentity(
          tmp,
          buildAddMessage(entry.title, entry.summary, entry.keywords, entry.digest, true),
          gitTimeoutMs,
          { env }
        );
        created.push({ file, hash });
      }
      // 6. verify the build before touching the original
      if (created.length !== entries.length) {
        throw new GitMemoError("gitmemo: migration entry count mismatch — aborting");
      }
      const status = (await git(tmp, ["status", "--porcelain"], gitTimeoutMs)).trim();
      if (status.length > 0) {
        throw new GitMemoError("gitmemo: migration build tree is dirty: " + status);
      }
      for (const createdEntry of created) {
        const added = await git(tmp, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", createdEntry.hash, "--", ENTRY_DIR + "/"], gitTimeoutMs);
        const lines = added.split("\n").filter((l) => /^A\tentries\/.+\.md$/.test(l));
        if (lines.length !== 1 || !lines[0].endsWith(createdEntry.file)) {
          throw new GitMemoError("gitmemo: commit/file mapping mismatch at " + createdEntry.hash + " — aborting");
        }
      }
      for (const hash of Object.values(baseline.tips)) {
        await resolveCommit(tmp, hash, gitTimeoutMs); // old tip must be reachable (via backup refs)
      }
      // 7. crash-recoverable compare-and-swap. A sibling journal is written
      // before either rename so search/write never mistake the gap for a fresh
      // project and initialize an empty `.mem`.
      const oldDir = join(root, `.mem.gitmemo-old-${ts}`);
      const targetDir = join(root, ".mem");
      if (memDir !== targetDir && await access(targetDir).then(() => true).catch(() => false)) {
        throw new GitMemoError(`gitmemo: migration target ${targetDir} already exists; move it away before migrating from ${memDir}`);
      }
      const swapJournal: MigrationSwapJournal = {
        operationId: randomBytes(8).toString("hex"),
        sourceDir: memDir,
        targetDir,
        oldDir,
        tmpDir: tmp,
        phase: "prepared",
        createdAt: new Date().toISOString()
      };
      await writeMigrationSwapJournal(root, swapJournal);
      if (memDir === targetDir) {
        await rename(memDir, oldDir);
        swapJournal.phase = "old-renamed";
        await writeMigrationSwapJournal(root, swapJournal);
      }
      try {
        await rename(tmp, targetDir);
        swapJournal.phase = "new-installed";
        await writeMigrationSwapJournal(root, swapJournal);
      } catch (error) {
        try {
          await recoverMigrationSwap(root, gitTimeoutMs);
          if ((await repoFormat(targetDir, gitTimeoutMs)) !== "new") throw error;
        } catch (restoreError) {
          throw new GitMemoError(
            `gitmemo: migration swap failed and automatic restore also failed. Old repository remains at ${oldDir}; ` +
              `temporary repository is ${tmp}; recovery journal is ${join(root, MIGRATION_JOURNAL_NAME)}. ` +
              `Original error: ${String(error)}; restore error: ${String(restoreError)}`
          );
        }
        throw error;
      }
      // objects now live in the new repo via the fetch; drop the old directory
      try {
        if (memDir === targetDir) await rm(oldDir, { recursive: true, force: true });
        await rm(join(root, MIGRATION_JOURNAL_NAME), { force: true });
      } catch {
        // The canonical new repo is already installed. Re-run the idempotent
        // recovery finalizer instead of reporting the migration itself failed.
        await recoverMigrationSwap(root, gitTimeoutMs);
      }
      await excludeFromParent(root, gitTimeoutMs);
      const newMain = (await git(targetDir, ["rev-parse", "HEAD"], gitTimeoutMs)).trim();
      return {
        migrated: true,
        entries: created.length,
        newMain,
        backupRefPrefix: `refs/gitmemo/backup/${ts}/`,
        oldBranches: baselineBranches
      };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
}

/**
 * Fully automatic migration for engine use: dry-run + apply in one step,
 * without taking the cross-process lock (the caller must already hold it).
 *
 * Never throws for user-resolvable blocking conditions — it returns
 * `blocked` instead, so the caller can fall back to legacy read-only mode
 * and retry automatically on a later operation.
 */
export async function migrateAutoUnlocked(root: string, options: MigrationOptions = {}): Promise<AutoMigrateOutcome> {
  const gitTimeoutMs = options.gitTimeoutMs ?? 60000;
  const memDir = resolve(options.source ?? join(root, ".mem"));
  await recoverMigrationSwap(root, gitTimeoutMs);
  if (!(await isGitRepo(memDir, gitTimeoutMs))) {
    return { migrated: false, blocked: { code: "no-repo", detail: "no .mem repository at " + memDir } };
  }
  if ((await repoFormat(memDir, gitTimeoutMs)) === "new") {
    return { migrated: false, alreadyNewFormat: true };
  }
  let report: MigrationDryRunReport;
  try {
    report = await migrateDryRunUnlocked(root, options);
  } catch (error) {
    if (error instanceof GitMemoError) {
      const code: AutoMigrateBlock["code"] = /no branches/.test(error.message) ? "no-branches" : "other";
      return { migrated: false, blocked: { code, detail: error.message } };
    }
    throw error;
  }
  if (!report.legacy) return { migrated: false, alreadyNewFormat: true };
  if (report.conflictCount > 0) {
    return {
      migrated: false,
      blocked: {
        code: "conflicts",
        detail:
          `${report.conflictCount} conflict(s) (same entry path, different content across branches):\n` +
          conflictManifest(report.baseline.conflicts)
      }
    };
  }
  try {
    const applied = await migrateApplyUnlocked(root, report.baseline, options);
    return {
      migrated: applied.migrated,
      ...(applied.alreadyMigrated === true ? { alreadyNewFormat: true } : {}),
      report: applied
    };
  } catch (error) {
    if (error instanceof GitMemoError) {
      const message = error.message;
      let code: AutoMigrateBlock["code"] = "other";
      if (/blocked by \d+ conflict/.test(message)) code = "conflicts";
      else if (/not clean.*refuses to discard/.test(message)) code = "dirty";
      else if (/interrupted transaction journal/.test(message)) code = "legacy-journal";
      else if (/baseline contains no branches/.test(message)) code = "no-branches";
      return { migrated: false, blocked: { code, detail: message } };
    }
    throw error;
  }
}
