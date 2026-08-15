// Engine + plugin unit tests for dsh-gitmemo (node:test).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitMemo } from "../lib/mem.js";

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
  return dir;
}
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("init creates a .mem repo with a .gitkeep commit and is idempotent", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const path = await memo.init();
  assert.equal(path, join(root, ".mem"));
  assert.ok(existsSync(join(root, ".mem", ".git")));
  assert.ok(existsSync(join(root, ".mem", "entries", ".gitkeep")));
  const log = git(join(root, ".mem"), ["log", "--oneline"]);
  assert.match(log, /init: initialize memory repo/);
  await memo.init(); // idempotent
  const log2 = git(join(root, ".mem"), ["log", "--oneline"]);
  assert.equal(log2, log);
});

test("write commits an entry and search/read round-trip it (CJK content)", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const content =
    "---\ndate: 2026-02-19T15:10:10Z\nstatus: done\n---\n### Original User Request\n给登录接口加限流\n### Final Outcome\n- 每 IP 10 req/min\n";
  const { hash, file } = await memo.write({ title: "[auth] add rate-limit for login", content });
  assert.match(hash, /^[0-9a-f]{40}$/);
  assert.match(file, /^entries\/\d{8}T\d{6}Z-auth-add-rate-limit-for-login\.md$/);
  assert.ok(existsSync(join(root, ".mem", file)));

  // search by keyword (auto mode)
  const found = await memo.search("auth,rate-limit");
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].hash, hash);
  assert.equal(found.results[0].title, "[auth] add rate-limit for login");
  assert.ok(found.results[0].date.length > 0);

  // case-insensitive single keyword
  const found2 = await memo.search("RATE-LIMIT");
  assert.equal(found2.results.length, 1);

  // read back
  const entry = await memo.read(hash);
  assert.equal(entry.file, file);
  assert.ok(entry.content.includes("给登录接口加限流"));
  assert.ok(entry.content.includes("每 IP 10 req/min"));

  // read with abbreviated hash
  const short = hash.slice(0, 8);
  const entry2 = await memo.read(short);
  assert.equal(entry2.content, entry.content);
});

test("branch alignment: .mem branch follows the project branch", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.write({ title: "[core] first memory on main", content: "entry one" });
  assert.equal(git(join(root, ".mem"), ["rev-parse", "--abbrev-ref", "HEAD"]), "main");

  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
  await memo.write({ title: "[core] memory on feature", content: "entry two" });
  assert.equal(git(join(root, ".mem"), ["rev-parse", "--abbrev-ref", "HEAD"]), "feature");

  // search sees both branches' memories (--all)
  const all = await memo.search("memory");
  assert.equal(all.results.length, 2);

  // branchAlign=false keeps the mem repo on its own branch
  const memoNoAlign = new GitMemo(root, { branchAlign: false });
  await memoNoAlign.write({ title: "[core] no-align memory", content: "entry three" });
  assert.equal(git(join(root, ".mem"), ["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
});

test("search modes: and / or / auto fallback", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await memo.write({ title: "alpha one", content: "a" });
  await memo.write({ title: "beta two", content: "b" });
  await memo.write({ title: "alpha beta three", content: "c" });

  // explicit and: only the entry containing BOTH keywords
  const and = await memo.search("alpha,beta", 0, "and");
  assert.equal(and.mode, "and");
  assert.equal(and.results.length, 1);
  assert.equal(and.results[0].title, "alpha beta three");

  // explicit or: everything matching either
  const or = await memo.search("alpha,beta", 0, "or");
  assert.equal(or.mode, "or");
  assert.equal(or.results.length, 3);

  // auto: AND yields 1 < 3, so it falls back to OR
  const auto = await memo.search("alpha,beta", 0, "auto");
  assert.equal(auto.mode, "or");
  assert.equal(auto.results.length, 3);

  // auto with a keyword present in 3+ entries stays on AND
  await memo.write({ title: "alpha four", content: "d" });
  const auto2 = await memo.search("alpha", 0, "auto");
  assert.equal(auto2.mode, "and");
  assert.equal(auto2.results.length, 3);
});

test("search pagination with skip", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const hashes = [];
  for (let i = 1; i <= 5; i += 1) {
    await sleep(20);
    const { hash } = await memo.write({ title: `entry number ${i}`, content: `e${i}` });
    hashes.push(hash);
  }
  const page1 = await memo.search("entry");
  assert.equal(page1.results.length, 5);
  assert.equal(page1.results[0].hash, hashes[4]); // newest first
  const page2 = await memo.search("entry", 2);
  assert.equal(page2.results.length, 3);
  assert.equal(page2.results[0].hash, hashes[2]);
  const page3 = await memo.search("entry", 20);
  assert.equal(page3.results.length, 0);
});

test("delete removes the entry from disk and search; second delete fails", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const keep = await memo.write({ title: "[auth] keep me", content: "keep" });
  const victim = await memo.write({ title: "[auth] remove me", content: "remove" });

  const file = await memo.delete(victim.hash);
  assert.match(file, /remove-me/);
  assert.ok(!existsSync(join(root, ".mem", file)));

  const found = await memo.search("auth");
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].hash, keep.hash);

  await assert.rejects(() => memo.delete(victim.hash), /file already deleted|no entry file/);
  await assert.rejects(() => memo.delete("0000000000000000000000000000000000000000"), /no entry file/);

  // audit trail: the write commit still resolves, the delete commit does not
  const deleteHash = git(join(root, ".mem"), ["log", "-1", "--format=%H"]);
  const audit = await memo.read(victim.hash);
  assert.ok(audit.content.includes("remove"));
  await assert.rejects(() => memo.read(deleteHash));
});

test("write via content_file (temp copied then deleted) and via file in place", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);

  // content_file outside .mem: copied into the repo, then deleted
  const tmpMd = join(root, "tmp-entry.md");
  writeFileSync(tmpMd, "---\nstatus: done\n---\nbody from temp file", "utf8");
  const w1 = await memo.write({ title: "[core] from temp file", contentFile: tmpMd });
  assert.ok(!existsSync(tmpMd), "temp content file deleted after write");
  assert.ok(existsSync(join(root, ".mem", w1.file)));
  assert.equal((await memo.read(w1.hash)).content, "---\nstatus: done\n---\nbody from temp file");

  // content_file already inside .mem/entries: committed in place, file kept
  const inPlace = join(root, ".mem", "entries", "20260101T000000Z-in-place.md");
  writeFileSync(inPlace, "in place entry", "utf8");
  const w2 = await memo.write({ title: "[core] in place", contentFile: inPlace });
  assert.ok(existsSync(inPlace), "in-place entry kept");
  assert.equal(w2.file, "entries/20260101T000000Z-in-place.md");
  assert.equal((await memo.read(w2.hash)).content, "in place entry");

  // file=entries/... commits a pre-written entry directly
  const pre = join(root, ".mem", "entries", "20260102T000000Z-pre.md");
  writeFileSync(pre, "pre-written entry", "utf8");
  const w3 = await memo.write({ title: "[core] pre-written", file: "entries/20260102T000000Z-pre.md" });
  assert.equal(w3.file, "entries/20260102T000000Z-pre.md");

  // .mem/entries/... normalization for --file
  const pre2 = join(root, ".mem", "entries", "20260102T000000Z-pre2.md");
  writeFileSync(pre2, "normalized entry", "utf8");
  const w4 = await memo.write({ title: "[core] normalized", file: ".mem/entries/20260102T000000Z-pre2.md" });
  assert.equal(w4.file, "entries/20260102T000000Z-pre2.md");
  assert.equal((await memo.read(w4.hash)).content, "normalized entry");

  // absolute path under .mem for --file
  const pre3 = join(root, ".mem", "entries", "20260102T000000Z-pre3.md");
  writeFileSync(pre3, "absolute entry", "utf8");
  const w5 = await memo.write({ title: "[core] absolute", file: join(root, ".mem", "entries", "20260102T000000Z-pre3.md") });
  assert.equal(w5.file, "entries/20260102T000000Z-pre3.md");

  // commit body round-trip (git log body)
  const w6 = await memo.write({ title: "[core] with body", content: "x", body: "summary line\n\ndate: 2026-01-01T00:00:00Z" });
  const bodyLog = git(join(root, ".mem"), ["log", "-1", "--format=%B", w6.hash]);
  assert.match(bodyLog, /summary line/);
  assert.match(bodyLog, /date: 2026-01-01T00:00:00Z/);
});

test("validation errors", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  await assert.rejects(() => memo.write({ title: "", content: "x" }), /requires --title/);
  await assert.rejects(() => memo.write({ title: "t", content: "x", contentFile: join(root, "f.md") }), /only one of content or contentFile/);
  await assert.rejects(() => memo.write({ title: "t", body: "b", bodyFile: join(root, "b.txt") }), /only one of body or bodyFile/);
  await assert.rejects(() => memo.write({ title: "t" }), /missing content/);
  await assert.rejects(() => memo.write({ title: "t", content: "x", bodyFile: join(root, "missing-body.txt") }), /body file not found/);
  await assert.rejects(() => memo.write({ title: "t", contentFile: join(root, "missing.md") }), /not found/);
  await assert.rejects(() => memo.write({ title: "t", file: "../evil.md", content: "x" }), /invalid file path/);
  await assert.rejects(() => memo.write({ title: "t", file: "/abs/evil.md", content: "x" }), /invalid file path/);
  writeFileSync(join(root, ".mem", "entries", "20260101T000000Z-in-place.md"), "exists", "utf8");
  await assert.rejects(
    () => memo.write({ title: "t", contentFile: join(root, ".mem", "entries", "20260101T000000Z-in-place.md"), file: "entries/other.md" }),
    /must match/
  );
  await assert.rejects(() => memo.search(""), /at least one non-empty keyword/);
  await assert.rejects(() => memo.search("a", -1), /non-negative integer/);
  await assert.rejects(() => memo.search("a", 0, "fuzzy"), /mode must be one of/);
  await assert.rejects(() => memo.read("zzz"), /requires a commit hash/);
});

test("search on an empty memory repo returns no results", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const found = await memo.search("anything");
  assert.equal(found.results.length, 0);
  assert.equal(found.mode, "or"); // auto: AND yields 0 < 3, falls back to OR
});

test("recentSync lists newest entries first, read-only", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const first = await memo.write({ title: "[demo] first", content: "one" });
  await sleep(20);
  const second = await memo.write({ title: "[demo] second", content: "two" });
  await sleep(20);
  const third = await memo.write({ title: "[demo] third", content: "three" });

  const hits = memo.recentSync(2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].hash, third.hash);
  assert.equal(hits[1].hash, second.hash);

  // deleted entries do not appear
  await memo.delete(third.hash);
  const hits2 = memo.recentSync(5);
  assert.deepEqual(hits2.map((h) => h.hash), [second.hash, first.hash]);

  // no .mem repo -> empty, and no repo is created
  const fresh = makeRepo();
  const memo2 = new GitMemo(fresh);
  assert.deepEqual(memo2.recentSync(5), []);
  assert.ok(!existsSync(join(fresh, ".mem")));
});

test("works in a non-git directory (root fallback)", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitmemo-nogit-"));
  dirs.push(root);
  const memo = new GitMemo(root);
  const { hash } = await memo.write({ title: "[x] standalone memory", content: "no git repo here" });
  assert.ok(existsSync(join(root, ".mem", ".git")));
  assert.equal((await memo.read(hash)).content, "no git repo here");
});

test("plugin module: exports, config schema, and tool registration on a stub ctx", async () => {
  const mod = await import("../lib/index.js");
  assert.equal(mod.name, "dsh-gitmemo");
  assert.deepEqual(mod.inject, ["tools", "systemPrompt"]);
  assert.ok(mod.Config, "Config schema exported");
  assert.equal(typeof mod.apply, "function");

  const registered = [];
  const sections = [];
  const eventHandlers = {};
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: { section: (section) => sections.push(section) },
    on: (event, handler) => { eventHandlers[event] = handler; },
    logger: { warn: () => {} }
  };
  await mod.apply(ctx, { memDirName: ".mem" });

  const names = registered.map((t) => t.name);
  assert.deepEqual(names, ["mem_init", "mem_search", "mem_read", "mem_write", "mem_delete"]);
  for (const tool of registered) {
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.output.schema.type === "object");
  }
  // search tool carries the gitmemo arg contract (compiled JSON Schema)
  const search = registered.find((t) => t.name === "mem_search");
  assert.ok(search.parameters.required.includes("keywords"));
  assert.deepEqual(search.parameters.properties.mode.enum, ["and", "or", "auto"]);
  assert.equal(search.parameters.properties.keywords.type, "string");

  // The always-on rules section carries the full workflow (agents-template equivalent)
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "memory:gitmemo");
  assert.match(sections[0].text, /BEFORE WORK/);
  assert.match(sections[0].text, /AFTER COMPLETION/);
  assert.match(sections[0].text, /USER UNSATISFIED/);
  assert.match(sections[0].text, /END-OF-SESSION CHECKPOINT/);

  // recent-context injection is wired to agent/created
  assert.equal(typeof eventHandlers["agent/created"], "function");
});

test("recent-context injection seeds new root sessions with recent memory titles", async () => {
  const root = makeRepo();
  const memo = new GitMemo(root);
  const first = await memo.write({ title: "[demo] first memory", content: "one" });
  await sleep(20);
  const second = await memo.write({ title: "[demo] second memory", content: "two" });

  const mod = await import("../lib/index.js");
  const contexts = [];
  const eventHandlers = {};
  const ctx = {
    tools: { register: () => {} },
    skills: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, handler) => { eventHandlers[event] = handler; },
    logger: { warn: (msg) => { throw new Error("unexpected warn: " + msg); } }
  };
  await mod.apply(ctx, { memDirName: ".mem", recentContextLimit: 5 });

  // root agent: session cwd = the repo root
  const rootAgent = {
    id: "root-agent",
    session: { header: { cwd: root } },
    ctx: { systemPrompt: { context: (section) => contexts.push(section) } }
  };
  eventHandlers["agent/created"]({ agent: rootAgent });
  await sleep(400); // async git lookup settles

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, "memory:gitmemo-recent");
  assert.match(contexts[0].text, new RegExp(second.hash));
  assert.match(contexts[0].text, new RegExp(first.hash));
  // newest first
  assert.ok(contexts[0].text.indexOf(second.hash) < contexts[0].text.indexOf(first.hash));

  // subagents (delegationDepth > 0) are skipped
  const subContexts = [];
  const sub = {
    id: "sub-agent",
    session: { header: { cwd: root, delegationDepth: 1 } },
    ctx: { systemPrompt: { context: (section) => subContexts.push(section) } }
  };
  eventHandlers["agent/created"]({ agent: sub });
  await sleep(200);
  assert.equal(subContexts.length, 0);
});

test("recent-context injection: no .mem repo -> no context, no repo created", async () => {
  const root = makeRepo(); // project repo without any .mem yet
  const mod = await import("../lib/index.js");
  const contexts = [];
  const eventHandlers = {};
  const ctx = {
    tools: { register: () => {} },
    skills: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, handler) => { eventHandlers[event] = handler; },
    logger: { warn: () => {} }
  };
  await mod.apply(ctx, { memDirName: ".mem", recentContextLimit: 5 });
  const agent = {
    id: "fresh-agent",
    session: { header: { cwd: root } },
    ctx: { systemPrompt: { context: (section) => contexts.push(section) } }
  };
  eventHandlers["agent/created"]({ agent });
  await sleep(400);
  assert.equal(contexts.length, 0);
  assert.ok(!existsSync(join(root, ".mem")), "session start must not create .mem");

  // recentContextLimit 0 disables the hook entirely
  const handlers2 = {};
  const ctx2 = {
    tools: { register: () => {} },
    skills: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, handler) => { handlers2[event] = handler; },
    logger: { warn: () => {} }
  };
  await mod.apply(ctx2, { memDirName: ".mem", recentContextLimit: 0 });
  assert.equal(handlers2["agent/created"], undefined);
});