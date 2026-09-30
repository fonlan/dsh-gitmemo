/**
 * Engine tests for configurable search scoring (`searchScoring`).
 *
 * Motivation: the LongMemEval measurements pinned the engine's ranking as its
 * defect — evidence was reachable (recall_all@50 = 0.998) but ranked poorly
 * (ndcg_any@5 = 0.686) — because a plain match count cannot tell a distinctive
 * keyword from a ubiquitous one. These tests pin the two properties that make
 * the fix safe: matching is identical in both modes, and only the ORDER moves.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const { GitMemo, keywordRarity, SEARCH_SCORING_MODES } = await import("../lib/mem.js");

async function withRepo(fn) {
  const root = await mkdtemp(join(tmpdir(), "gitmemo-scoring-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function memo(root, searchScoring) {
  return new GitMemo(root, { searchLimit: 50, searchScoring, gitTimeoutMs: 60000, lockTimeoutMs: 60000 });
}

/** 1 rare entry ("xylophone") among many entries sharing the common word. */
async function seedRareAmongCommon(root, memoForWrite) {
  await memoForWrite.init();
  for (let i = 0; i < 8; i += 1) {
    await memoForWrite.write({
      title: `[task] routine status update ${i}`,
      summary: "A routine status update mentioning the common word release across many entries.",
      keywords: ["release", "routine", `status${i}`],
      content: `body ${i}`
    });
  }
  const rare = await memoForWrite.write({
    title: "[task] the xylophone tuning session",
    summary: "A single entry about tuning a xylophone.",
    keywords: ["xylophone", "tuning"],
    content: "rare body"
  });
  return rare;
}

test("searchScoring rejects unknown modes", () => {
  assert.throws(() => new GitMemo("/tmp", { searchScoring: "nope" }), /searchScoring must be one of/);
  for (const mode of SEARCH_SCORING_MODES) {
    assert.ok(new GitMemo("/tmp", { searchScoring: mode }));
  }
});

test("keywordRarity: rarer within the page means a larger weight", () => {
  // n candidates total; df = how many of them matched the keyword.
  const ubiquitous = keywordRarity(40, 40);
  const middling = keywordRarity(10, 40);
  const rare = keywordRarity(1, 40);
  assert.ok(ubiquitous < middling && middling < rare);
  assert.ok(ubiquitous > 0, "a universally matched keyword still contributes a little");
  assert.equal(keywordRarity(0, 10), keywordRarity(0, 10));
  assert.ok(keywordRarity(0, 10) > keywordRarity(10, 10), "df=0 must weigh more than df=n");
});

test("weighted scoring ranks a distinctive match above many common ones", async () => {
  await withRepo(async (root) => {
    const writer = memo(root, "weighted");
    const rare = await seedRareAmongCommon(root, writer);

    const weighted = await writer.search(["release", "xylophone"]);
    const counted = await memo(root, "count").search(["release", "xylophone"]);

    // Both modes must agree on WHICH entries match — recall is not the lever.
    const ids = (out) => out.results.map((h) => h.hash).sort();
    assert.deepEqual(ids(weighted), ids(counted), "the matched set must be identical in both modes");

    // The distinctive entry matches once ("xylophone"); the routine ones match
    // once too ("release"), so a plain count ties them and must fall back to
    // recency — while rarity puts the distinctive entry first outright.
    assert.equal(weighted.results[0].hash, rare.hash, "weighted mode must rank the rare match first");
    assert.deepEqual(weighted.results[0].matched_keywords, ["xylophone"]);
  });
});

test("count mode keeps the pre-existing ordering semantics", async () => {
  await withRepo(async (root) => {
    const writer = memo(root, "count");
    const rare = await seedRareAmongCommon(root, writer);
    const out = await writer.search(["release", "xylophone"]);
    // Every match is worth exactly 1 in count mode, plus a recency bonus of at
    // most 0.5, so the scores land in [1, 1.5].
    for (const hit of out.results) {
      assert.ok(hit.score >= 1 && hit.score <= 1.5, `count-mode score out of range: ${hit.score}`);
    }
    assert.ok(out.results.some((h) => h.hash === rare.hash));
  });
});

test("an entry matching TWO keywords outranks one matching a single keyword in count mode", async () => {
  await withRepo(async (root) => {
    const writer = memo(root, "count");
    await writer.init();
    const two = await writer.write({
      title: "[task] alpha and beta together",
      summary: "mentions alpha beta",
      keywords: ["alpha", "beta"],
      content: "two"
    });
    await writer.write({
      title: "[task] alpha alone",
      summary: "mentions alpha only",
      keywords: ["alpha", "gamma"],
      content: "one"
    });
    const out = await writer.search(["alpha", "beta"]);
    assert.equal(out.results[0].hash, two.hash);
    assert.equal(out.results[0].matched_keywords.length, 2);
  });
});

test("the search cache is keyed by scoring mode (an A/B must not share a ranking)", async () => {
  await withRepo(async (root) => {
    const writer = memo(root, "weighted");
    const rare = await seedRareAmongCommon(root, writer);
    // Same repo, same snapshot, same keywords, different mode — the cache key
    // must include the mode or the second handle reads the first's ranking.
    const weightedFirst = await memo(root, "weighted").search(["release", "xylophone"]);
    const countedNext = await memo(root, "count").search(["release", "xylophone"]);
    const weightedAgain = await memo(root, "weighted").search(["release", "xylophone"]);
    assert.equal(weightedFirst.results[0].hash, rare.hash);
    assert.equal(weightedAgain.results[0].hash, rare.hash);
    assert.notDeepEqual(
      weightedFirst.results.map((h) => h.score),
      countedNext.results.map((h) => h.score),
      "identical scores across modes would mean the cache returned one ranking for both"
    );
  });
});

test("weighted scoring stays deterministic across repeated searches", async () => {
  await withRepo(async (root) => {
    const writer = memo(root, "weighted");
    await seedRareAmongCommon(root, writer);
    const first = await memo(root, "weighted").search(["release", "xylophone"]);
    const second = await memo(root, "weighted").search(["release", "xylophone"]);
    assert.deepEqual(
      first.results.map((h) => [h.hash, h.score]),
      second.results.map((h) => [h.hash, h.score])
    );
  });
});

test("a keyword matched by every candidate contributes little but still matches", async () => {
  await withRepo(async (root) => {
    const writer = memo(root, "weighted");
    await writer.init();
    await writeFile(join(root, "unused.txt"), "x");
    for (let i = 0; i < 3; i += 1) {
      await writer.write({
        title: `[task] entry ${i}`,
        summary: "all entries share the ubiquitous word",
        keywords: ["ubiquitous", `id${i}`],
        content: `b${i}`
      });
    }
    const out = await writer.search(["ubiquitous"]);
    assert.equal(out.results.length, 3, "a universally matched keyword must still recall every entry");
    for (const hit of out.results) assert.ok(hit.score < 1, `ubiquitous-only score should be tiny, got ${hit.score}`);
  });
});

test("weighted mode deliberately drops 'match count dominates' — a rare match can beat two common ones", async () => {
  // This is the contract CHANGE that `weighted` introduces, stated as a test so
  // it cannot drift silently: the old guarantee (test/mem.test.mjs, count mode)
  // was that one matched keyword can never outrank two. Under weighting, a
  // distinctive keyword legitimately does — that is the whole point, and it is
  // what lifted LongMemEval recall_all@5 from 0.684 to 0.737 on the same data.
  await withRepo(async (root) => {
    const writer = memo(root, "weighted");
    await writer.init();
    // 12 entries share two common keywords; one entry carries a rare keyword.
    for (let i = 0; i < 12; i += 1) {
      await writer.write({
        title: `[task] weekly report ${i}`,
        summary: "weekly report summary with the usual wording",
        keywords: ["weekly", "report", `item${i}`],
        content: `b${i}`
      });
    }
    const rare = await writer.write({
      title: "[task] the harpsichord restoration",
      summary: "A single entry about restoring a harpsichord.",
      keywords: ["harpsichord", "restoration"],
      content: "rare"
    });

    // two common matches vs one rare match
    const weighted = await writer.search(["weekly", "report", "harpsichord"]);
    const counted = await memo(root, "count").search(["weekly", "report", "harpsichord"]);
    assert.equal(weighted.results[0].hash, rare.hash, "weighted: the rare match wins with a single keyword");
    assert.ok(
      counted.results[0].matched_keywords.length === 2,
      "count mode: a two-match entry still leads, as documented for that mode"
    );
    // Same matched set regardless — only the order differs.
    assert.deepEqual(
      weighted.results.map((h) => h.hash).sort(),
      counted.results.map((h) => h.hash).sort()
    );
  });
});

test("weighted and count agree on WHICH entries match, across a range of queries", async () => {
  await withRepo(async (root) => {
    const writer = memo(root, "weighted");
    await seedRareAmongCommon(root, writer);
    const queries = [
      ["release"],
      ["xylophone"],
      ["release", "xylophone"],
      ["tuning", "routine"],
      ["status3", "release"]
    ];
    for (const q of queries) {
      const w = await memo(root, "weighted").search(q);
      const c = await memo(root, "count").search(q);
      assert.deepEqual(
        w.results.map((h) => h.hash).sort(),
        c.results.map((h) => h.hash).sort(),
        `matched set differs for ${JSON.stringify(q)}`
      );
    }
  });
});
