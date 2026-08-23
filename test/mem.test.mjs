// Engine + plugin + migration tests for dsh-gitmemo v2 (node:test).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { GitMemo, GitMemoError, MIGRATION_JOURNAL_NAME, computeDigest, normalizeText } from "../lib/mem.js";
import { migrateDryRun, migrateApply } from "../lib/migrate.js";

// Deterministic commit identity for every git subprocess spawned by tests.
process.env.GIT_AUTHOR_NAME = "gitmemo-test";
process.env.GIT_AUTHOR_EMAIL = "gitmemo-test@example.com";
process.env.GIT_COMMITTER_NAME = "gitmemo-test";
process.env.GIT_COMMITTER_EMAIL = "gitmemo-test@example.com";

const dirs = [];
function makeRepo(name = "repo") {
  const dir = mkdtempSync(join(tmpdir(), `gitmemo-${name}-`));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "gitmemo-test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "gitmemo-test@example.com"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: dir });
  return dir;
}
function makeNonGitDir(name = "nogit") {
  const dir = mkdtempSync(join(tmpdir(), `gitmemo-${name}-`));
  dirs.push(dir);
  return dir;
}
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}
function writeEntry(root, rel, content) {
  const full = join(root, ".mem", rel);
  writeFileSync(full, content, "utf8");
}

function assertLosslessJson(value, message = "value must round-trip through JSON without loss") {
  const encoded = JSON.stringify(value);
  assert.notEqual(encoded, undefined, message);
  assert.deepEqual(JSON.parse(encoded), value, message);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// init / format
// ---------------------------------------------------------------------------

test("init creates a new-format .mem repo (format marker + .gitkeep + main) and is idempotent", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const path = await memo.init();
  assert.equal(path, join(root, ".mem"));
  assert.ok(existsSync(join(root, ".mem", ".git")));
  assert.equal(readFileSync(join(root, ".mem", ".gitmemo-format"), "utf8").trim(), "2");
  assert.ok(existsSync(join(root, ".mem", "entries", ".gitkeep")));
  assert.equal(git(join(root, ".mem"), ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  const log = git(join(root, ".mem"), ["log", "--format=%s"]);
  assert.match(log, /init: initialize memory repo/);
  // parent .git/info/exclude carries .mem/ and the lock path
  const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /(^|\n)\.mem\//);
  assert.match(exclude, /(^|\n)\.mem\.gitmemo\.lock/);
  // idempotent
  await memo.init();
  assert.equal(git(join(root, ".mem"), ["log", "--format=%s"]), log);
});

test("init refuses when the parent repo already tracks .mem content", async () => {
  const root = makeRepo();
  writeFileSync(join(root, ".mem-probe"), "x", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "track probe"], { cwd: root });
  // track a directory named .mem
  execFileSync("mkdir", ["-p", join(root, ".mem")]);
  writeFileSync(join(root, ".mem", "tracked.txt"), "t", "utf8");
  execFileSync("git", ["add", ".mem"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "track .mem"], { cwd: root });
  const memo = new GitMemo(root);
  await assert.rejects(() => memo.init(), /already tracks \.mem/);
});

test("init works in a non-git directory and writes code metadata as unknown", async () => {
  const root = makeNonGitDir();
  const memo = new GitMemo(root);
  const { hash } = await memo.write({ title: "[x] standalone memory", summary: "no git repo here", keywords: ["standalone", "memory"], content: "body" });
  assert.ok(existsSync(join(root, ".mem", ".git")));
  const entry = await memo.read(hash);
  assert.match(entry.content, /code_branch: "unknown"/);
  assert.match(entry.content, /code_commit: "unknown"/);
});

// ---------------------------------------------------------------------------
// write / immutable entries / metadata
// ---------------------------------------------------------------------------

test("write creates an immutable entry file with engine-generated front matter and structured commit trailers", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const { hash, file } = await memo.write({
    title: "[auth] add login rate limit",
    summary: "Implemented per-IP login rate limiting.",
    keywords: ["auth", "rate-limit", "登录", "限流"],
    content: "每 IP 10 req/min 已上线。",
    related_branches: ["feature/login-limit"],
    related_paths: ["src/auth/login.ts"]
  });
  assert.match(hash, /^[0-9a-f]{40}$/);
  assert.match(file, /^entries\/\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{8}-auth-add-login-rate-limit\.md$/);
  assert.ok(existsSync(join(root, ".mem", file)));

  // front matter generated by the engine
  const content = readFileSync(join(root, ".mem", file), "utf8");
  assert.match(content, /gitmemo_version: "2"/);
  assert.match(content, /code_branch: "main"/);
  assert.match(content, /code_commit: "[0-9a-f]{40}"/);
  assert.match(content, /related_branches: \["feature\/login-limit", "main"\]/);
  assert.match(content, /related_paths: \["src\/auth\/login\.ts"\]/);
  assert.match(content, /keywords: \["auth", "rate-limit", "登录", "限流"\]/);
  assert.match(content, /# \[auth\] add login rate limit/);
  assert.match(content, /## Summary/);
  assert.match(content, /## Final Outcome/);
  assert.ok(content.includes("每 IP 10 req/min 已上线。"));

  // structured commit message
  const message = git(join(root, ".mem"), ["log", "-1", "--format=%B", hash]);
  assert.match(message, /^\[auth\] add login rate limit\n/);
  assert.match(message, /GitMemo-Type: add/);
  assert.match(message, /GitMemo-Keyword: auth/);
  assert.match(message, /GitMemo-Keyword: 登录/);
  assert.match(message, /GitMemo-Digest: sha256:[0-9a-f]{64}/);
  assert.match(message, /GitMemo-Search-Text: \[auth\] add login rate limit/);
  assert.match(message, /GitMemo-Search-Text: implemented per-ip login rate limiting\./);
  assert.match(message, /GitMemo-Search-Text: 限流/);

  // read round-trips
  const entry = await memo.read(hash);
  assert.equal(entry.file, file);
  assert.equal(entry.content, content);
  assert.equal(entry.legacy, undefined);
  assert.equal(Object.hasOwn(entry, "legacy"), false);
  assertLosslessJson(entry);
  // abbreviated hash works
  const short = await memo.read(hash.slice(0, 8));
  assert.equal(short.content, content);
});

test("write: .mem stays on main while the project switches branches; metadata follows the code branch", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.write({ title: "[core] on main", summary: "s1", keywords: ["main", "记忆"], content: "one" });
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
  const w2 = await memo.write({ title: "[core] on feature", summary: "s2", keywords: ["feature", "分支"], content: "two" });
  assert.equal(git(join(root, ".mem"), ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  const entry2 = await memo.read(w2.hash);
  assert.match(entry2.content, /code_branch: "feature"/);
  // detached HEAD records detached:<sha>
  execFileSync("git", ["checkout", "-q", "HEAD~0"], { cwd: root });
  const sha = git(root, ["rev-parse", "HEAD"]);
  const w3 = await memo.write({ title: "[core] detached", summary: "s3", keywords: ["detached", "head"], content: "three" });
  const entry3 = await memo.read(w3.hash);
  assert.match(entry3.content, new RegExp(`code_branch: "detached:${sha}"`));
});

test("write validation: required fields, lengths, control chars, trailer injection", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const base = { title: "[t] ok", summary: "s", keywords: ["a", "b"], content: "c" };
  await assert.rejects(() => memo.write({ ...base, title: "" }), /non-empty title/);
  await assert.rejects(() => memo.write({ ...base, title: "a\nb" }), /single line/);
  await assert.rejects(() => memo.write({ ...base, title: "x".repeat(201) }), /at most 200/);
  await assert.rejects(() => memo.write({ ...base, title: "x\u0000y" }), /control characters/);
  await assert.rejects(() => memo.write({ ...base, title: "GitMemo-Type: add" }), /reserved GitMemo-\* trailer/);
  await assert.rejects(() => memo.write({ ...base, summary: "" }), /non-empty summary/);
  await assert.rejects(() => memo.write({ ...base, summary: "x".repeat(4001) }), /at most 4000/);
  await assert.rejects(() => memo.write({ ...base, summary: "ok\nGitMemo-Type: add" }), /reserved GitMemo-\* trailer/);
  await assert.rejects(() => memo.write({ ...base, content: "" }), /non-empty content/);
  await assert.rejects(() => memo.write({ ...base, content: "x".repeat(1024 * 1024 + 1) }), /1 MiB/);
  await assert.rejects(() => memo.write({ ...base, keywords: ["a"] }), /2-12/);
  await assert.rejects(() => memo.write({ ...base, keywords: ["Auth", "ＡＵＴＨ"] }), /distinct entries/);
  await assert.rejects(() => memo.write({ ...base, keywords: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"] }), /2-12/);
  await assert.rejects(() => memo.write({ ...base, keywords: ["a", "x".repeat(65)] }), /at most 64/);
  await assert.rejects(() => memo.write({ ...base, keywords: ["a", "GitMemo-Digest: sha256:00"] }), /reserved GitMemo-\* trailer/);
  await assert.rejects(
    () => memo.write({ ...base, related_branches: ["ok", "bad\nbranch"] }),
    /newlines/
  );
  await assert.rejects(() => memo.write({ ...base, related_paths: ["/abs/path"] }), /project-relative/);
  await assert.rejects(() => memo.write({ ...base, related_paths: ["../escape"] }), /escapes the project root/);
  await assert.rejects(() => memo.write({ ...base, related_paths: ["a\u0001b"] }), /control characters/);
  // keywords dedupe (NFKC + case-fold) keeps a write legal
  const w = await memo.write({ ...base, keywords: ["Auth", "ＡＵＴＨ", "auth", "b"] });
  const message = git(join(root, ".mem"), ["log", "-1", "--format=%B", w.hash]);
  assert.equal((message.match(/GitMemo-Keyword:/g) ?? []).length, 2);
});

test("write digest dedupe: active duplicates rejected; delete then re-write allowed", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const payload = { title: "[d] same", summary: "identical", keywords: ["dup", "test"], content: "same body" };
  const first = await memo.write(payload);
  await assert.rejects(() => memo.write(payload), /same digest already exists/);
  // a write with the same digest only blocked while active
  await memo.delete({ commit_hash: first.hash, reason: "withdraw" });
  const second = await memo.write(payload);
  assert.notEqual(second.hash, first.hash);
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test("search: OR recall over title/summary/keywords only; body-only words never hit; score and matched_keywords", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const a = await memo.write({
    title: "[auth] add login rate limit",
    summary: "Per-IP limiting with Redis.",
    keywords: ["auth", "rate-limit", "登录", "限流"],
    content: "secret marker ONLY IN BODY"
  });
  const b = await memo.write({
    title: "[db] add index",
    summary: "Index on user_id.",
    keywords: ["database", "index"],
    content: "x"
  });

  // title hit
  const byTitle = await memo.search(["login"]);
  assert.equal(byTitle.results.length, 1);
  assert.equal(byTitle.results[0].hash, a.hash);
  // summary hit
  const bySummary = await memo.search(["redis"]);
  assert.equal(bySummary.results.length, 1);
  assert.equal(bySummary.results[0].hash, a.hash);
  // keyword hit (中英文)
  const byKeyword = await memo.search(["限流"]);
  assert.equal(byKeyword.results.length, 1);
  assert.equal(byKeyword.results[0].hash, a.hash);
  // body-only word does NOT hit
  const byBody = await memo.search(["secret"]);
  assert.equal(byBody.results.length, 0);
  // OR + score
  const multi = await memo.search(["auth", "database"]);
  assert.equal(multi.results.length, 2);
  const byHash = Object.fromEntries(multi.results.map((h) => [h.hash, h]));
  assert.equal(byHash[a.hash].score, 1);
  assert.deepEqual(byHash[a.hash].matched_keywords, ["auth"]);
  assert.deepEqual(byHash[b.hash].matched_keywords, ["database"]);
  const multi2 = await memo.search(["auth", "登录", "限流"]);
  assert.equal(multi2.results.length, 1);
  assert.equal(multi2.results[0].hash, a.hash);
  assert.equal(multi2.results[0].score, 3);
  assert.deepEqual([...multi2.results[0].matched_keywords].sort(), ["auth", "登录", "限流"]);
  assert.deepEqual(multi2.results[0].keywords, ["auth", "rate-limit", "登录", "限流"]);
});

test("search: normalization (NFKC, case folding, whitespace) and literal special chars", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.write({ title: "[x] Alpha.Beta[Test]*Star", summary: "Weird chars.", keywords: ["Alpha", "Beta", "CaseTest"], content: "c" });

  // case folding: lowercase query hits mixed-case title/keywords
  const folded = await memo.search(["alpha"]);
  assert.equal(folded.results.length, 1);
  const folded2 = await memo.search(["casetest"]);
  assert.equal(folded2.results.length, 1);
  // NFKC: full-width chars fold to ASCII
  const nfkc = await memo.search(["ＡＬＰＨＡ"]);
  assert.equal(nfkc.results.length, 1);
  // whitespace collapsing
  await memo.write({ title: "[y] spaced  out   title", summary: "a  b", keywords: ["c", "d"], content: "e" });
  const spaced = await memo.search(["spaced   out"]);
  assert.equal(spaced.results.length, 1);
  // literal special chars: `a.b`, `[x]`, `*` are fixed strings, not regex
  const dot = await memo.search(["a.b"]);
  assert.equal(dot.results.length, 1);
  const bracket = await memo.search(["[test]"]);
  assert.equal(bracket.results.length, 1);
  const star = await memo.search(["*"]);
  assert.equal(star.results.length, 1);
  // a regex-only pattern does not recall (fixed-string semantics)
  const regexOnly = await memo.search(["Alpha.*Star"]);
  assert.equal(regexOnly.results.length, 0);

  // Unicode full case folding: sharp s expands to ss.
  await memo.write({ title: "[i18n] Straße routing", summary: "German street names", keywords: ["straße", "routing"], content: "c" });
  const sharpS = await memo.search(["strasse"]);
  assert.equal(sharpS.results.length, 1);
});

test("search validates and deduplicates normalized query keywords", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const entry = await memo.write({ title: "[q] auth entry", summary: "auth", keywords: ["auth", "query"], content: "c" });
  const found = await memo.search(["Auth", "ＡＵＴＨ", "auth"]);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].hash, entry.hash);
  assert.equal(found.results[0].score, 1);
  assert.deepEqual(found.results[0].matched_keywords, ["auth"]);
  await assert.rejects(() => memo.search(["x".repeat(65)]), /at most 64/);
  await assert.rejects(() => memo.search(["bad\nquery"]), /single line/);
});

test("engine rejects non-positive non-integer search limits", async () => {
  const root = makeRepo();
  assert.throws(() => new GitMemo(root, { searchLimit: NaN }), /positive integer/);
  assert.throws(() => new GitMemo(root, { searchLimit: Infinity }), /positive integer/);
  assert.throws(() => new GitMemo(root, { searchLimit: 0 }), /positive integer/);
  assert.throws(() => new GitMemo(root, { searchLimit: 2.5 }), /positive integer/);
  assert.throws(() => new GitMemo(root, { searchLimit: -1 }), /positive integer/);
});

test("search pagination returns an explicit next_skip for middle pages", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root, { searchLimit: 2 });
  for (let i = 0; i < 3; i += 1) {
    await memo.write({ title: `[page] entry ${i}`, summary: "s", keywords: ["page", "hit"], content: `c${i}` });
  }
  const first = await memo.search(["page"]);
  assert.equal(first.total, 3);
  assert.equal(first.next_skip, 2);
  assert.equal(first.results.length, 2);
  assertLosslessJson(first);
  const second = await memo.search(["page"], { skip: first.next_skip });
  assert.equal(second.total, 3);
  assert.equal(second.next_skip, null);
  assert.equal(second.results.length, 1);
  assertLosslessJson(second);
});

test("read returns the full commit hash even for abbreviated input", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const written = await memo.write({ title: "[r] full hash", summary: "s", keywords: ["read", "hash"], content: "c" });
  const read = await memo.read(written.hash.slice(0, 8));
  assert.equal(read.hash, written.hash);
  assertLosslessJson(read);
});

test("search survives out-of-range committer timestamps with an epoch fallback", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.write({ title: "[t] normal entry", summary: "s", keywords: ["timestamp", "normal"], content: "c" });
  const memDir = join(root, ".mem");
  const head = git(memDir, ["rev-parse", "HEAD"]);
  const message = [
    "[t] huge entry",
    "huge summary",
    "",
    "GitMemo-Type: add",
    "GitMemo-Keyword: huge",
    "GitMemo-Keyword: timestamp",
    "GitMemo-Digest: sha256:" + "0".repeat(64),
    "GitMemo-Search-Text: [t] huge entry",
    "GitMemo-Search-Text: huge summary",
    "GitMemo-Search-Text: huge",
    "GitMemo-Search-Text: timestamp",
    "GitMemo-Legacy: false",
    ""
  ].join("\n");
  const stream =
    "blob\nmark :2\ndata 1\nh\n" +
    "commit refs/heads/main\nmark :1\ncommitter T <t@t> 99999999999999 +0000\n" +
    `data ${Buffer.byteLength(message, "utf8")}\n${message}` +
    `from ${head}\n` +
    "M 100644 :2 entries/huge.md\n";
  const result = spawnSync("git", ["-C", memDir, "fast-import"], { input: stream, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const found = await memo.search(["huge"]);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].date, new Date(0).toISOString());
  assertLosslessJson(found);
});

test("search pagination: snapshot is stable across new writes; stale snapshot rejected", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const hashes = [];
  for (let i = 1; i <= 5; i += 1) {
    // deterministic, strictly increasing commit dates (git stores seconds)
    process.env.GIT_COMMITTER_DATE = `2026-01-0${i}T00:00:00+00:00`;
    process.env.GIT_AUTHOR_DATE = `2026-01-0${i}T00:00:00+00:00`;
    const { hash } = await memo.write({ title: `entry number ${i}`, summary: `s${i}`, keywords: ["entry", "num"], content: `e${i}` });
    hashes.push(hash);
  }
  delete process.env.GIT_COMMITTER_DATE;
  delete process.env.GIT_AUTHOR_DATE;
  const page1 = await memo.search(["entry"], { skip: 0 });
  assert.equal(page1.results.length, 5);
  assert.deepEqual(page1.results.map((h) => h.hash), [...hashes].reverse()); // newest first
  assert.equal(page1.total, 5);
  assert.equal(page1.next_skip, null);
  const snapshot = page1.snapshot;
  assert.match(snapshot, /^[0-9a-f]{40}$/);

  // new writes after the snapshot must not shift pagination
  await memo.write({ title: "entry number 6", summary: "s6", keywords: ["entry", "num"], content: "e6" });
  const page1b = await memo.search(["entry"], { skip: 0, snapshot });
  assert.equal(page1b.results.length, 5);
  assert.equal(page1b.total, 5);
  const page2 = await memo.search(["entry"], { skip: 2, snapshot });
  assert.deepEqual(page2.results.map((h) => h.hash), [...hashes].reverse().slice(2));
  // fresh search (new snapshot) sees the new entry
  const fresh = await memo.search(["entry"]);
  assert.equal(fresh.total, 6);

  // history rewrite makes the snapshot stale: reset main back to the init commit
  const initCommit = git(join(root, ".mem"), ["rev-parse", "HEAD~6"]);
  execFileSync("git", ["reset", "-q", "--hard", initCommit], { cwd: join(root, ".mem") });
  await assert.rejects(
    () => memo.search(["entry"], { skip: 0, snapshot }),
    /stale snapshot/
  );
});

test("search: deleted and replaced entries disappear; historical hashes still readable", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const a = await memo.write({ title: "[a] keep", summary: "s", keywords: ["keep", "entry"], content: "k" });
  const b = await memo.write({ title: "[b] victim", summary: "s", keywords: ["victim", "entry"], content: "v" });
  const c = await memo.write({ title: "[c] victim2", summary: "s", keywords: ["victim", "entry"], content: "v2" });

  await memo.delete({ commit_hash: b.hash, reason: "obsolete" });
  const replaced = await memo.replace({
    commit_hash: c.hash,
    title: "[c] victim2 revised",
    summary: "new summary",
    keywords: ["victim", "entry", "revised"],
    content: "v2 revised"
  });

  const found = await memo.search(["victim"]);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].hash, replaced.hash);
  // old hashes stay readable
  assert.ok((await memo.read(b.hash)).content.includes("v"));
  assert.ok((await memo.read(c.hash)).content.includes("v2"));
  // delete commits are not searchable entries
  await memo.delete({ commit_hash: a.hash, reason: "gone" });
  const deleteHash = git(join(root, ".mem"), ["log", "-1", "--format=%H"]);
  await assert.rejects(() => memo.read(deleteHash), /no entry file/);
});

test("search on a fresh repo returns no results; legacy adapter for string keywords and mode", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const empty = await memo.search(["anything"]);
  assert.equal(empty.results.length, 0);
  assert.equal(empty.total, 0);
  assert.equal(empty.next_skip, null);
  assert.equal(Object.hasOwn(empty, "legacy"), false);
  assert.equal(Object.hasOwn(empty, "warning"), false);
  assert.equal(Object.hasOwn(empty, "diagnostics"), false);
  assertLosslessJson(empty);
  // legacy string keywords + mode → adapter with warnings
  await memo.write({ title: "[x] alpha beta", summary: "s", keywords: ["alpha", "beta"], content: "c" });
  const legacy = await memo.search("alpha,beta", { mode: "and" });
  assert.equal(legacy.results.length, 1);
  assert.match(legacy.warning, /deprecation/);
  assert.match(legacy.warning, /mode is gone/);
});

test("blank search snapshot is treated as an omitted first-page snapshot", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const written = await memo.write({ title: "[s] blank snapshot", summary: "s", keywords: ["snapshot", "blank"], content: "c" });
  const found = await memo.search(["snapshot"], { snapshot: "   " });
  assert.equal(found.results[0].hash, written.hash);
  assert.match(found.snapshot, /^[0-9a-f]{40}$/);
  assertLosslessJson(found);
});

// ---------------------------------------------------------------------------
// replace / delete semantics
// ---------------------------------------------------------------------------

test("replace: one commit deletes the old file and adds the new one with GitMemo-Replaces", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const original = await memo.write({
    title: "[auth] login rate limit",
    summary: "10 req/min",
    keywords: ["auth", "rate-limit"],
    content: "old body"
  });
  const before = git(join(root, ".mem"), ["rev-parse", "HEAD"]);
  const result = await memo.replace({
    commit_hash: original.hash,
    title: "[auth] login rate limit revised",
    summary: "20 req/min",
    keywords: ["auth", "rate-limit", "revised"],
    content: "new body"
  });
  const after = git(join(root, ".mem"), ["rev-parse", "HEAD"]);
  assert.equal(before, git(join(root, ".mem"), ["rev-parse", "HEAD~1"]));
  assert.notEqual(after, before);
  // single commit: D old + A new (--no-renames: the file pair must not collapse into a rename)
  const status = git(join(root, ".mem"), ["show", "--no-renames", "--name-status", "--format=", result.hash]);
  assert.match(status, new RegExp("D\\t" + original.file.replace(/\./g, "\\.")));
  assert.match(status, new RegExp("A\\t" + result.file.replace(/\./g, "\\.")));
  assert.ok(!existsSync(join(root, ".mem", original.file)));
  assert.ok(existsSync(join(root, ".mem", result.file)));
  // trailer
  const message = git(join(root, ".mem"), ["log", "-1", "--format=%B", result.hash]);
  assert.match(message, /GitMemo-Type: replace/);
  assert.match(message, new RegExp("GitMemo-Replaces: " + original.hash));
  // search sees only the new entry
  const found = await memo.search(["rate-limit"]);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].hash, result.hash);
  assert.equal((await memo.read(original.hash)).content.includes("old body"), true);
});

test("replace: stale hashes rejected; digest dedupe excludes the replaced entry itself", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const a = await memo.write({ title: "[a] first", summary: "s1", keywords: ["a1", "k"], content: "one" });
  const bPayload = { title: "[b] second", summary: "s2", keywords: ["a2", "k"], content: "two" };
  const b = await memo.write(bPayload);
  // stale hash: an already-replaced hash cannot be replaced again
  const rep = await memo.replace({
    commit_hash: a.hash,
    title: "[a] first revised",
    summary: "s1r",
    keywords: ["a1", "k", "rev"],
    content: "one revised"
  });
  await assert.rejects(
    () => memo.replace({ commit_hash: a.hash, title: "[a] again", summary: "s", keywords: ["a1", "k"], content: "x" }),
    /not the active entry/
  );
  // digest dedupe: colliding with ANOTHER active entry rejected
  await assert.rejects(
    () => memo.replace({
      commit_hash: rep.hash,
      title: bPayload.title,
      summary: bPayload.summary,
      keywords: bPayload.keywords,
      content: bPayload.content
    }),
    /another active entry uses the same digest/
  );
  // same digest as the replaced entry itself (only metadata change) is legal
  const metaOnly = await memo.replace({
    commit_hash: rep.hash,
    title: "[a] first revised",
    summary: "s1r",
    keywords: ["a1", "k", "rev"],
    content: "one revised",
    related_paths: ["src/a.ts"]
  });
  const found = await memo.search(["a1"]);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].hash, metaOnly.hash);
});

test("delete: reason required; commit records GitMemo-Deletes; second delete fails", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const keep = await memo.write({ title: "[auth] keep me", summary: "k", keywords: ["keep", "auth"], content: "keep" });
  const victim = await memo.write({ title: "[auth] remove me", summary: "r", keywords: ["remove", "auth"], content: "remove" });

  await assert.rejects(() => memo.delete({ commit_hash: victim.hash, reason: "  " }), /requires a reason/);

  const { file } = await memo.delete({ commit_hash: victim.hash, reason: "conclusion obsolete" });
  assert.match(file, /remove-me/);
  assert.ok(!existsSync(join(root, ".mem", file)));
  const message = git(join(root, ".mem"), ["log", "-1", "--format=%B"]);
  assert.match(message, /^delete: withdraw /);
  assert.match(message, /conclusion obsolete/);
  assert.match(message, /GitMemo-Type: delete/);
  assert.match(message, new RegExp("GitMemo-Deletes: " + victim.hash));

  const found = await memo.search(["auth"]);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].hash, keep.hash);

  await assert.rejects(() => memo.delete({ commit_hash: victim.hash, reason: "again" }), /not the active entry/);
  await assert.rejects(() => memo.delete({ commit_hash: "0000000000000000000000000000000000000000", reason: "x" }), /no such commit/);
  await assert.rejects(
    () => memo.delete({ commit_hash: keep.hash, reason: "withdraw\n  GitMemo-Deletes: forged" }),
    /reserved GitMemo-\* trailer/
  );
  // audit: old hash still readable; the delete commit itself is not an entry
  const audit = await memo.read(victim.hash);
  assert.ok(audit.content.includes("remove"));
});

// ---------------------------------------------------------------------------
// concurrency / locks / journal / dirty state
// ---------------------------------------------------------------------------

test("two engine instances in one process serialize writes via the mutex", async () => {
  const root = makeRepo();
  const memoA = new GitMemo(root);
  const memoB = new GitMemo(root);
  const results = await Promise.all([
    memoA.write({ title: "[c] from A", summary: "a", keywords: ["conc", "a"], content: "A" }),
    memoB.write({ title: "[c] from B", summary: "b", keywords: ["conc", "b"], content: "B" })
  ]);
  assert.equal(results.length, 2);
  const found = await memoA.search(["conc"]);
  assert.equal(found.results.length, 2);
});

test("cross-process concurrent init and writes leave a valid repo with all entries", async () => {
  const root = makeRepo();
  const script = `
    import { GitMemo } from ${JSON.stringify(join(process.cwd(), "lib/mem.js"))};
    const memo = new GitMemo(${JSON.stringify(root)});
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await memo.write({ title: "[\u005bproc\u005d entry " + i + " " + process.pid, summary: "s" + i, keywords: ["proc", "conc"], content: "p" + i + "-" + process.pid });
      out.push(r.hash);
    }
    console.log(JSON.stringify(out));
  `;
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const [r1, r2] = await Promise.all([Promise.resolve(run()), Promise.resolve(run())]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const hashes = [...JSON.parse(r1.stdout), ...JSON.parse(r2.stdout)];
  assert.equal(new Set(hashes).size, 6);
  const memo = new GitMemo(root);
  const found = await memo.search(["proc"]);
  assert.equal(found.results.length, 6);
  // no leftover lock, no journal
  assert.ok(!existsSync(join(root, ".mem.gitmemo.lock")));
  assert.ok(!existsSync(join(root, ".mem", ".git", "gitmemo-transaction.json")));
});

test("stale lock is cleared; a live lock times out with a clear error", async () => {
  const root = makeRepo();
  // stale: dead pid on this host, older than the safety margin
  writeFileSync(
    join(root, ".mem.gitmemo.lock"),
    JSON.stringify({ pid: 999999999, host: hostname(), startedAt: new Date(Date.now() - 120000).toISOString(), operation: "write", operationId: "x" }),
    "utf8"
  );
  const memo = new GitMemo(root, { lockTimeoutMs: 2000 });
  const { hash } = await memo.write({ title: "[l] stale cleared", summary: "s", keywords: ["lock", "stale"], content: "c" });
  assert.ok(!existsSync(join(root, ".mem.gitmemo.lock")));
  assert.match(hash, /^[0-9a-f]{40}$/);

  // live lock: our own pid → must time out
  writeFileSync(
    join(root, ".mem.gitmemo.lock"),
    JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), operation: "write", operationId: "live" }),
    "utf8"
  );
  await assert.rejects(
    () => memo.write({ title: "[l] blocked", summary: "s", keywords: ["lock", "live"], content: "c" }),
    /timed out.*waiting for lock/
  );
  // a foreign-host lock is not judged stale
  writeFileSync(
    join(root, ".mem.gitmemo.lock"),
    JSON.stringify({ pid: 999999999, host: "other-host", startedAt: new Date(Date.now() - 120000).toISOString(), operation: "write", operationId: "x" }),
    "utf8"
  );
  await assert.rejects(
    () => memo.write({ title: "[l] foreign", summary: "s", keywords: ["lock", "foreign"], content: "c" }),
    /timed out.*waiting for lock/
  );
});

test("dirty worktree aborts writes; unknown staged files are never committed", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.write({ title: "[d] first", summary: "s", keywords: ["dirty", "one"], content: "1" });
  // untracked file
  writeEntry(root, "entries/user-manual.md", "manual edit");
  await assert.rejects(() => memo.write({ title: "[d] blocked", summary: "s", keywords: ["dirty", "two"], content: "2" }), /not clean/);
  // staged unknown file
  execFileSync("git", ["add", "entries/user-manual.md"], { cwd: join(root, ".mem") });
  await assert.rejects(() => memo.write({ title: "[d] blocked2", summary: "s", keywords: ["dirty", "three"], content: "3" }), /not clean/);
  // user file untouched, no commit happened
  assert.ok(existsSync(join(root, ".mem", "entries", "user-manual.md")));
  const found = await memo.search(["dirty"]);
  assert.equal(found.results.length, 1);
});

test("journal recovery: interrupted write is rolled back safely and the next write succeeds", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const first = await memo.write({ title: "[j] base", summary: "s", keywords: ["journal", "base"], content: "1" });
  // simulate a crash mid-write: file written + staged, journal present, HEAD unchanged
  const baseHead = git(join(root, ".mem"), ["rev-parse", "HEAD"]);
  const fakeFile = "entries/20260101T000000.000Z-deadbeef-journal-crash.md";
  writeEntry(root, fakeFile, "half-written");
  execFileSync("git", ["add", fakeFile], { cwd: join(root, ".mem") });
  writeFileSync(
    join(root, ".mem", ".git", "gitmemo-transaction.json"),
    JSON.stringify({ operationId: "j1", operation: "write", phase: "prepared", baseHead, add: [fakeFile], delete: [], digest: "d", createdAt: new Date().toISOString() }),
    "utf8"
  );
  // next write recovers (rolls back the fake add) then commits
  const next = await memo.write({ title: "[j] after crash", summary: "s", keywords: ["journal", "after"], content: "2" });
  assert.ok(!existsSync(join(root, ".mem", fakeFile)));
  assert.ok(!existsSync(join(root, ".mem", ".git", "gitmemo-transaction.json")));
  assert.equal(git(join(root, ".mem"), ["log", "--format=%H"]).split("\n").length, 3); // init + base + next
  const found = await memo.search(["journal"]);
  assert.equal(found.results.length, 2);
  void first;
});

test("journal recovery handles staged replace without rename ambiguity", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const original = await memo.write({ title: "[j] replace base", summary: "s", keywords: ["journal", "replace"], content: "old" });
  const baseHead = git(join(root, ".mem"), ["rev-parse", "HEAD"]);
  const newFile = "entries/20260101T000000.000Z-deadbeef-replace-crash.md";
  writeEntry(root, newFile, "replacement");
  rmSync(join(root, ".mem", original.file));
  execFileSync("git", ["add", "-A", "--", original.file, newFile], { cwd: join(root, ".mem") });
  writeFileSync(
    join(root, ".mem", ".git", "gitmemo-transaction.json"),
    JSON.stringify({
      operationId: "replace-crash",
      operation: "replace",
      phase: "prepared",
      baseHead,
      add: [newFile],
      delete: [original.file],
      createdAt: new Date().toISOString()
    }),
    "utf8"
  );
  const next = await memo.write({ title: "[j] after replace crash", summary: "s", keywords: ["journal", "after"], content: "new" });
  assert.match(next.hash, /^[0-9a-f]{40}$/);
  assert.ok(existsSync(join(root, ".mem", original.file)), "old entry restored");
  assert.ok(!existsSync(join(root, ".mem", newFile)), "planned new entry removed");
});

test("journal is present before entry creation and recovers when creation fails", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.init();
  const entriesDir = join(root, ".mem", "entries");
  chmodSync(entriesDir, 0o555);
  try {
    await assert.rejects(
      () => memo.write({ title: "[j] cannot create", summary: "s", keywords: ["journal", "create"], content: "c" }),
      /EACCES|permission|operation not permitted/i
    );
    assert.ok(existsSync(join(root, ".mem", ".git", "gitmemo-transaction.json")));
  } finally {
    chmodSync(entriesDir, 0o755);
  }
  const recovered = await memo.write({ title: "[j] recovered", summary: "s", keywords: ["journal", "recovered"], content: "c" });
  assert.match(recovered.hash, /^[0-9a-f]{40}$/);
  assert.ok(!existsSync(join(root, ".mem", ".git", "gitmemo-transaction.json")));
});

test("journal recovery refuses when HEAD moved or paths differ", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.write({ title: "[j] base", summary: "s", keywords: ["journal", "base"], content: "1" });
  const journalPath = join(root, ".mem", ".git", "gitmemo-transaction.json");
  // HEAD moved: journal base is an ancestor, current HEAD is ahead
  writeFileSync(journalPath, JSON.stringify({
    operationId: "j2", operation: "write", phase: "prepared",
    baseHead: git(join(root, ".mem"), ["rev-parse", "HEAD~1"]),
    add: ["entries/x.md"], delete: [], digest: "d", createdAt: new Date().toISOString()
  }), "utf8");
  await assert.rejects(() => memo.write({ title: "[j] refused", summary: "s", keywords: ["journal", "refused"], content: "2" }), /interrupted transaction/);
  // extra unknown path: rollback must be refused
  writeFileSync(journalPath, JSON.stringify({
    operationId: "j3", operation: "write", phase: "prepared",
    baseHead: git(join(root, ".mem"), ["rev-parse", "HEAD"]),
    add: ["entries/x.md"], delete: [], digest: "d", createdAt: new Date().toISOString()
  }), "utf8");
  writeEntry(root, "entries/x.md", "x");
  writeEntry(root, "entries/y.md", "y"); // unknown extra
  execFileSync("git", ["add", "entries/x.md", "entries/y.md"], { cwd: join(root, ".mem") });
  await assert.rejects(() => memo.write({ title: "[j] refused2", summary: "s", keywords: ["journal", "refused"], content: "3" }), /interrupted transaction/);
});

test("corrupt transaction journal is never mistaken for no journal", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.init();
  writeFileSync(join(root, ".mem", ".git", "gitmemo-transaction.json"), "{broken", "utf8");
  await assert.rejects(
    () => memo.write({ title: "[j] blocked", summary: "s", keywords: ["journal", "corrupt"], content: "c" }),
    /transaction journal is unreadable/
  );
});

test("a journal left after a successful commit is recognized and cleared", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const committed = await memo.write({ title: "[j] committed", summary: "s", keywords: ["journal", "committed"], content: "c" });
  const head = git(join(root, ".mem"), ["rev-parse", "HEAD"]);
  const parent = git(join(root, ".mem"), ["rev-parse", "HEAD^"]);
  writeFileSync(
    join(root, ".mem", ".git", "gitmemo-transaction.json"),
    JSON.stringify({
      operationId: "post-commit",
      operation: "write",
      phase: "prepared",
      baseHead: parent,
      add: [committed.file],
      delete: [],
      createdAt: new Date().toISOString()
    }),
    "utf8"
  );
  assert.equal(head, committed.hash);
  const next = await memo.write({ title: "[j] next", summary: "s", keywords: ["journal", "next"], content: "n" });
  assert.match(next.hash, /^[0-9a-f]{40}$/);
  assert.ok(!existsSync(join(root, ".mem", ".git", "gitmemo-transaction.json")));
});

// ---------------------------------------------------------------------------
// legacy repos
// ---------------------------------------------------------------------------

/** Build a legacy-format .mem repo (no format marker, old-style commits). */
function makeLegacyMem(root) {
  const mem = join(root, ".mem");
  execFileSync("mkdir", ["-p", join(mem, "entries")], {});
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: mem });
  execFileSync("git", ["config", "user.name", "gitmemo-test"], { cwd: mem });
  execFileSync("git", ["config", "user.email", "gitmemo-test@example.com"], { cwd: mem });
  writeFileSync(join(mem, "entries", ".gitkeep"), "", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "init: initialize memory repo"], { cwd: mem });
  const commitLegacy = (file, title, body) => {
    writeFileSync(join(mem, "entries", file), body, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: mem });
    execFileSync("git", ["commit", "-q", "-m", title, "-m", body], { cwd: mem });
  };
  commitLegacy("20260101T000000Z-legacy-one.md", "[legacy] one", "---\ntags: [legacy, old]\n---\n### Final Outcome\nLegacy entry one.");
  commitLegacy("20260102T000000Z-legacy-two.md", "[legacy] two", "plain legacy body two");
  return mem;
}

test("legacy repo: search/read are read-only with a migration warning; writes are refused", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  const memo = new GitMemo(root);

  const found = await memo.search(["legacy"]);
  assert.equal(found.results.length, 2);
  assert.equal(found.legacy, true);
  assert.match(found.warning, /legacy format/);

  const read = await memo.read(found.results[0].hash);
  assert.equal(read.legacy, true);

  await assert.rejects(
    () => memo.write({ title: "[x] no", summary: "s", keywords: ["a", "b"], content: "c" }),
    /legacy format.*migrate/s
  );
  await assert.rejects(
    () => memo.delete({ commit_hash: found.results[0].hash, reason: "x" }),
    /legacy format/
  );
  await assert.rejects(
    () => memo.replace({ commit_hash: found.results[0].hash, title: "t", summary: "s", keywords: ["a", "b"], content: "c" }),
    /legacy format/
  );
  // no --all cross-branch leakage: an extra branch is invisible
  execFileSync("git", ["checkout", "-q", "-b", "side"], { cwd: mem });
  writeFileSync(join(mem, "entries", "20260103T000000Z-side.md"), "side branch memory", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[side] hidden"], { cwd: mem });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: mem });
  const after = await memo.search(["hidden"]);
  assert.equal(after.results.length, 0);
});

test("legacy search honors a stable snapshot and engine legacy write adapter converts old fields", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  const memo = new GitMemo(root);
  const first = await memo.search(["legacy"]);
  writeFileSync(join(mem, "entries", "later.md"), "later legacy", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[legacy] later", "-m", "later legacy"], { cwd: mem });
  const stable = await memo.search(["legacy"], { snapshot: first.snapshot });
  assert.equal(stable.total, first.total);

  // Adapter is engine-facing: body/content_file are converted deterministically.
  rmSync(mem, { recursive: true, force: true });
  const contentFile = join(root, "legacy-content.md");
  writeFileSync(contentFile, "legacy adapter body", "utf8");
  const adapted = await memo.write({
    title: "[legacy] adapted",
    body: "legacy adapter summary",
    content_file: contentFile,
    keywords: []
  }, true);
  assert.equal(adapted.legacy, true);
  assert.match((await memo.read(adapted.hash)).content, /legacy adapter summary/);
});

test("new-format repository missing main is reported as damaged", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.init();
  execFileSync("git", ["branch", "-m", "side"], { cwd: join(root, ".mem") });
  await assert.rejects(() => memo.search(["anything"]), /new-format.*missing refs\/heads\/main.*damaged/);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test("migration dry-run: counts, dedupe, conflicts; touches no refs", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  // same content on a second branch (different path) → dedupe by content
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: mem });
  writeFileSync(join(mem, "entries", "20260101T000000Z-legacy-one-copy.md"), "---\ntags: [legacy, old]\n---\n### Final Outcome\nLegacy entry one.", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[legacy] one (feature copy)"], { cwd: mem });
  // same path different content → conflict
  writeFileSync(join(mem, "entries", "20260102T000000Z-legacy-two.md"), "conflicting content on feature", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[legacy] two (feature edit)"], { cwd: mem });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: mem });

  const refsBefore = git(mem, ["for-each-ref", "--format=%(refname)"]);
  const report = await migrateDryRun(root);
  assert.equal(report.legacy, true);
  assert.equal(report.oldEntryCount, 5); // main 2 + feature tree 3 (legacy-one inherited + copy + edited two)
  assert.equal(report.uniqueEntryCount, 1); // only legacy-one (deduped) survives; legacy-two conflicted
  assert.equal(report.conflictCount, 1);
  assert.equal(report.estimatedMainCommits, 2); // 1 init + 1 entry
  assert.equal(report.baseline.conflicts[0].path, "entries/20260102T000000Z-legacy-two.md");
  // dry-run touches no refs
  assert.equal(git(mem, ["for-each-ref", "--format=%(refname)"]), refsBefore);
  assert.equal(git(mem, ["status", "--porcelain"]), "");
  // keywords inferred from legacy front matter; summary from Final Outcome
  assert.deepEqual(report.baseline.entries[0].keywords, ["legacy", "old"]);
  assert.equal(report.baseline.entries[0].summary, "Legacy entry one.");
});

test("migration sanitizes low-quality legacy keywords instead of blocking", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  const bad = "x".repeat(80) + "\u0001";
  writeFileSync(
    join(mem, "entries", "bad-keyword.md"),
    `---\ntags: [${bad}, safe]\n---\n### Final Outcome\nLegacy with poor metadata.`,
    "utf8"
  );
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[legacy] poor metadata"], { cwd: mem });
  const report = await migrateDryRun(root);
  const entry = report.baseline.entries.find((item) => item.sourcePath === "entries/bad-keyword.md");
  assert.ok(entry);
  assert.ok(entry.keywords.every((keyword) => keyword.length <= 64 && !/[\u0000-\u001F\u007F]/.test(keyword)));
  assert.ok(report.warnings.some((warning) => /sanitized legacy keyword/.test(warning)));
  const applied = await migrateApply(root, report.baseline);
  assert.equal(applied.migrated, true);
});

test("migration apply: backup refs, new canonical main, old hashes stay readable", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  const oldHashes = {};
  // still on main from makeLegacyMem
  writeFileSync(join(mem, "entries", "20260102T000000Z-main.md"), "### Final Outcome\nMemory on main", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[main] memory"], { cwd: mem });
  oldHashes.main = git(mem, ["log", "-1", "--format=%H"]);
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: mem });
  writeFileSync(join(mem, "entries", "20260102T000000Z-feature.md"), "### Final Outcome\nMemory on feature", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[feature] memory"], { cwd: mem });
  oldHashes.feature = git(mem, ["log", "-1", "--format=%H"]);
  execFileSync("git", ["checkout", "-q", "main"], { cwd: mem });
  const oldHead = git(mem, ["rev-parse", "HEAD"]);

  const report = await migrateDryRun(root);
  assert.equal(report.conflictCount, 0);
  assert.equal(report.uniqueEntryCount, 4); // legacy-one, legacy-two + 2 branch memories (all distinct content)

  const applied = await migrateApply(root, report.baseline);
  assert.equal(applied.migrated, true);
  assert.equal(applied.entries, 4);
  assert.match(applied.backupRefPrefix, /refs\/gitmemo\/backup\//);

  const newMem = join(root, ".mem");
  assert.equal(git(newMem, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(readFileSync(join(newMem, ".gitmemo-format"), "utf8").trim(), "2");
  // backup refs exist and keep every old tip reachable
  const backupRefs = git(newMem, ["for-each-ref", "--format=%(refname)", "refs/gitmemo/backup"]);
  for (const branch of ["main", "feature"]) {
    assert.match(backupRefs, new RegExp(`refs/gitmemo/backup/[^/]+/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  assert.equal(git(newMem, ["cat-file", "-e", oldHead + "^{commit}"]), "");
  // old hash readable through mem_read (audit), search works on the new repo
  const memo = new GitMemo(root);
  const oldEntry = await memo.read(oldHashes.main);
  assert.ok(oldEntry.content.includes("Memory on main"));
  const found = await memo.search(["legacy"]);
  assert.equal(found.results.length, 2);
  assert.equal(found.legacy, undefined);
  // worktree clean, no journal/lock leftovers
  assert.equal(git(newMem, ["status", "--porcelain"]), "");
  assert.ok(!existsSync(join(newMem, ".git", "gitmemo-transaction.json")));
  assert.ok(!existsSync(join(root, ".mem.gitmemo.lock")));
  // the parent repo's info/exclude carries .mem/ and the lock path
  const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /(^|\n)\.mem\//);
  assert.match(exclude, /(^|\n)\.mem\.gitmemo\.lock/);
});

test("migration apply: conflicts block apply; changed baseline refs abort", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: mem });
  writeFileSync(join(mem, "entries", "20260102T000000Z-legacy-two.md"), "conflict on feature", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[legacy] two edit"], { cwd: mem });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: mem });

  const report = await migrateDryRun(root);
  assert.equal(report.conflictCount, 1);
  await assert.rejects(() => migrateApply(root, report.baseline), /blocked by 1 conflict/);

  // clean baseline, then mutate a branch → apply aborts
  execFileSync("git", ["branch", "-D", "feature"], { cwd: mem });
  const report2 = await migrateDryRun(root);
  assert.equal(report2.conflictCount, 0);
  writeFileSync(join(mem, "entries", "new-file.md"), "new", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: mem });
  execFileSync("git", ["commit", "-q", "-m", "[x] new"], { cwd: mem });
  await assert.rejects(() => migrateApply(root, report2.baseline), /changed since the dry-run baseline/);
});

test("migration apply refuses a dirty legacy worktree", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  const report = await migrateDryRun(root);
  writeFileSync(join(mem, "entries", "uncommitted.md"), "do not discard", "utf8");
  await assert.rejects(() => migrateApply(root, report.baseline), /not clean.*refuses to discard/s);
  assert.ok(existsSync(join(mem, "entries", "uncommitted.md")));
});

test("migration apply rejects a baseline from another project root", async () => {
  const root = makeRepo();
  makeLegacyMem(root);
  const report = await migrateDryRun(root);
  const other = makeRepo("other-root");
  await assert.rejects(() => migrateApply(other, report.baseline), /different project root/);
  await assert.rejects(
    () => migrateApply(root, { format: "dsh-gitmemo-migration-baseline", version: 1 }),
    /invalid migration baseline/
  );
});

test("interrupted migration swap is restored before automatic initialization", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  const oldDir = join(root, ".mem.gitmemo-old-test");
  const tmp = join(root, ".mem.gitmemo-tmp-test");
  renameSync(mem, oldDir);
  writeFileSync(
    join(root, MIGRATION_JOURNAL_NAME),
    JSON.stringify({
      operationId: "swap-test",
      sourceDir: mem,
      targetDir: mem,
      oldDir,
      tmpDir: tmp,
      phase: "old-renamed",
      createdAt: new Date().toISOString()
    }),
    "utf8"
  );
  const memo = new GitMemo(root);
  const found = await memo.search(["legacy"]);
  assert.equal(found.total, 2);
  assert.ok(existsSync(join(root, ".mem", ".git")));
  assert.ok(!existsSync(oldDir));
  assert.ok(!existsSync(join(root, MIGRATION_JOURNAL_NAME)));
});

test("migration apply: no conflicts → fully automatic (no per-entry manual steps)", async () => {
  const root = makeRepo();
  const mem = makeLegacyMem(root);
  const report = await migrateDryRun(root);
  assert.equal(report.conflictCount, 0);
  const applied = await migrateApply(root, report.baseline);
  assert.equal(applied.migrated, true);
  assert.equal(applied.entries, 2);
  // legacy entries carry GitMemo-Legacy: true and allow 0 keywords
  const memo = new GitMemo(root);
  const found = await memo.search(["legacy"]);
  assert.equal(found.results.length, 2);
  const legacyOne = found.results.find((h) => h.keywords.length === 2);
  assert.ok(legacyOne, "front-matter keywords preserved");
  const message = git(join(root, ".mem"), ["log", "--format=%B", legacyOne.hash]);
  assert.match(message, /GitMemo-Legacy: true/);
  // re-running dry-run reports already-new-format
  const again = await migrateDryRun(root);
  assert.equal(again.alreadyNewFormat, true);
});

test("migration CLI supports baseline files and direct --apply", () => {
  const cli = join(process.cwd(), "lib", "cli.js");

  const root = makeRepo("cli-baseline");
  makeLegacyMem(root);
  const baseline = join(root, "migration-baseline.json");
  const dry = spawnSync(process.execPath, [cli, "migrate", "--project-root", root, "--dry-run", "--out", baseline], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(existsSync(baseline));
  const applySaved = spawnSync(process.execPath, [cli, "migrate", "--project-root", root, "--apply", "--baseline", baseline], { encoding: "utf8" });
  assert.equal(applySaved.status, 0, applySaved.stderr);
  assert.match(applySaved.stdout, /migration applied/);

  const directRoot = makeRepo("cli-direct");
  makeLegacyMem(directRoot);
  const applyDirect = spawnSync(process.execPath, [cli, "migrate", "--project-root", directRoot, "--apply"], { encoding: "utf8" });
  assert.equal(applyDirect.status, 0, applyDirect.stderr);
  assert.match(applyDirect.stdout, /migration applied/);
});

test("migration from a non-default source keeps the source and installs canonical .mem", async () => {
  const root = makeRepo("custom-source");
  const defaultMem = makeLegacyMem(root);
  const source = join(root, "legacy-memory-source");
  renameSync(defaultMem, source);
  const report = await migrateDryRun(root, { source });
  const applied = await migrateApply(root, report.baseline, { source });
  assert.equal(applied.migrated, true);
  assert.ok(existsSync(join(source, ".git")), "legacy source is retained for explicit-source migrations");
  assert.equal(readFileSync(join(root, ".mem", ".gitmemo-format"), "utf8").trim(), "2");
  const found = await new GitMemo(root).search(["legacy"]);
  assert.equal(found.total, 2);
});

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

test("plugin: exports, config, scoped registration for root agents only, no mem_init", async () => {
  const mod = await import("../lib/index.js");
  assert.equal(mod.name, "dsh-gitmemo");
  assert.deepEqual(mod.inject, ["tools", "systemPrompt"]);
  assert.ok(mod.Config, "Config schema exported");
  assert.equal(typeof mod.apply, "function");

  const eventHandlers = {};
  const warns = [];
  const ctx = {
    on: (event, handler) => { eventHandlers[event] = handler; },
    logger: { warn: (msg) => warns.push(msg) }
  };
  await mod.apply(ctx, { searchLimit: 20 });
  assert.equal(typeof eventHandlers["agent/created"], "function");

  const rootRegistrations = { tools: [], sections: [] };
  const rootCtx = {
    tools: { register: (tool) => rootRegistrations.tools.push(tool) },
    systemPrompt: { section: (section) => rootRegistrations.sections.push(section) }
  };
  eventHandlers["agent/created"]({ agent: { id: "root", session: { header: { cwd: "/tmp", delegationDepth: 0 } }, ctx: rootCtx } });
  const names = rootRegistrations.tools.map((t) => t.name);
  assert.deepEqual(names, ["mem_search", "mem_read", "mem_write", "mem_delete", "mem_replace"]);
  assert.ok(!names.includes("mem_init"), "mem_init removed from the model surface");
  for (const tool of rootRegistrations.tools) {
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.output.schema.type === "object");
  }
  // workflow section carries the new rules
  assert.equal(rootRegistrations.sections.length, 1);
  assert.equal(rootRegistrations.sections[0].name, "memory:gitmemo");
  assert.match(rootRegistrations.sections[0].text, /mem_replace/);
  assert.match(rootRegistrations.sections[0].text, /mem_delete/);
  assert.match(rootRegistrations.sections[0].text, /BEFORE WORK/);
  assert.match(rootRegistrations.sections[0].text, /END-OF-SESSION CHECKPOINT/);

  // subagents get nothing
  const subRegistrations = { tools: [], sections: [] };
  const subCtx = {
    tools: { register: (tool) => subRegistrations.tools.push(tool) },
    systemPrompt: { section: (section) => subRegistrations.sections.push(section) }
  };
  eventHandlers["agent/created"]({ agent: { id: "sub", session: { header: { cwd: "/tmp", delegationDepth: 1 } }, ctx: subCtx } });
  assert.equal(subRegistrations.tools.length, 0);
  assert.equal(subRegistrations.sections.length, 0);

  // deprecated config emits warnings
  const warns2 = [];
  await mod.apply({ on: () => {}, logger: { warn: (m) => warns2.push(m) } }, { branchAlign: false, recentContextLimit: 0 });
  assert.ok(warns2.some((w) => /branchAlign.*deprecated/.test(w)));
  assert.ok(warns2.some((w) => /recentContextLimit.*deprecated/.test(w)));
});

test("plugin tools work end-to-end with the new contracts and legacy adapter", async () => {
  const mod = await import("../lib/index.js");
  const toolRoot = makeNonGitDir();
  const registrations = [];
  const eventHandlers = {};
  await mod.apply(
    { on: (event, handler) => { eventHandlers[event] = handler; }, logger: { warn: () => {} } },
    { searchLimit: 20 }
  );
  const agentCtx = { tools: { register: (t) => registrations.push(t) }, systemPrompt: { section: () => {} } };
  eventHandlers["agent/created"]({ agent: { id: "a1", session: { header: { cwd: toolRoot, delegationDepth: 0 } }, ctx: agentCtx } });
  const byName = Object.fromEntries(registrations.map((t) => [t.name, t]));
  const exec = { agent: { session: { header: { cwd: toolRoot } } } };

  // new contract: keywords array required
  const search = byName.mem_search;
  assert.equal(search.parameters.properties.keywords.type, "array");
  assert.equal(search.parameters.properties.mode, undefined);

  const write = byName.mem_write;
  const w = await write.execute({
    title: "[tool] new write",
    summary: "engine summary",
    keywords: ["tool", "write"],
    content: "body",
    related_paths: ["src/tool.ts"]
  }, exec);
  assert.equal(Object.hasOwn(w, "legacy"), false);
  assertLosslessJson(w);
  const memo = new GitMemo(toolRoot);
  const entry = await memo.read(w.hash);
  assert.match(entry.content, /gitmemo_version: "2"/);
  assert.match(entry.content, /code_branch: "unknown"/);

  const s = await search.execute({ keywords: ["tool"] }, exec);
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].hash, w.hash);
  assertLosslessJson(s);
  const sBlankSnapshot = await search.execute({ keywords: ["tool"], snapshot: "" }, exec);
  assert.equal(sBlankSnapshot.results[0].hash, w.hash);
  assertLosslessJson(sBlankSnapshot);

  const readTool = byName.mem_read;
  const readOutput = await readTool.execute({ commit_hash: w.hash }, exec);
  assert.equal(Object.hasOwn(readOutput, "legacy"), false);
  assert.equal(readOutput.commit_hash, w.hash);
  assertLosslessJson(readOutput);
  const abbreviatedRead = await readTool.execute({ commit_hash: w.hash.slice(0, 8) }, exec);
  assert.equal(abbreviatedRead.commit_hash, w.hash);

  // legacy adapter: engine-level string keywords + mode map with deprecation warnings
  const sLegacy = await memo.search("tool,write", { mode: "and" });
  assert.equal(sLegacy.results.length, 1);
  assert.match(sLegacy.warning, /deprecation/);
  // ...but the tool schema enforces the new array contract (model-facing surface)
  await assert.rejects(
    () => search.execute({ keywords: "tool,write" }, exec),
    /must be an array/
  );

  // legacy write adapter lives at the engine level (plan 10.7): body→summary,
  // content_file→content, 0-keyword writes allowed, marked legacy
  const wLegacy = await memo.write(
    { title: "[tool] legacy write", summary: "legacy summary", keywords: [], content: "legacy body" },
    true
  );
  assert.equal(wLegacy.legacy, true);
  const legacyEntry = await memo.read(wLegacy.hash);
  assert.match(legacyEntry.content, /## Summary\n\nlegacy summary/);
  // ...the tool schema enforces the new strict write contract (model-facing)
  await assert.rejects(
    () => write.execute({ title: "[tool] legacy shape", body: "b", content: "c" }, exec),
    /missing required property "summary"/
  );

  // old `file` in-place commit is rejected with guidance (plugin adapter)
  await assert.rejects(
    () => write.execute(
      { title: "[tool] file", summary: "s", keywords: ["a", "b"], content: "c", file: "entries/x.md" },
      exec
    ),
    /immutable entry model/
  );

  // delete requires reason
  const del = byName.mem_delete;
  await assert.rejects(() => del.execute({ commit_hash: w.hash }, exec), /reason/);

  // replace works through the plugin
  const rep = byName.mem_replace;
  const r = await rep.execute({
    commit_hash: w.hash,
    title: "[tool] new write revised",
    summary: "engine summary v2",
    keywords: ["tool", "write", "revised"],
    content: "body v2"
  }, exec);
  const s2 = await search.execute({ keywords: ["tool"] }, exec);
  assert.equal(s2.results.length, 2); // legacy + replaced
  const s3 = await search.execute({ keywords: ["tool"] }, exec);
  const replacedHit = s3.results.find((h) => h.hash === r.hash);
  assert.ok(replacedHit);
});

test("normalization contract: NFKC + case folding + whitespace collapse", () => {
  assert.equal(normalizeText("ＡＢＣ"), "abc");
  assert.equal(normalizeText("  a   b\tc "), "a b c");
  assert.equal(normalizeText("Rate-Limit"), "rate-limit");
  const digest = computeDigest("T", "S", ["Auth", "ＡＵＴＨ", "auth"], "C");
  const digest2 = computeDigest("T", "S", ["auth"], "C");
  assert.equal(digest, digest2, "keyword normalization makes digests stable");
});

test("GitMemoError is thrown for engine-level failures", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  try {
    await memo.write({ title: "t", summary: "s", keywords: ["a"], content: "c" });
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof GitMemoError);
  }
});
