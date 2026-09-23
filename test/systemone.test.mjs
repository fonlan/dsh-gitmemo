// System-one recall gate tests (node:test): wire contract, decision logic,
// fail-open behaviour, and the plugin-level fallback path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildRequest,
  decide,
  evaluateGate,
  parseAnswers,
  parseUsage,
  NOUL_CRITERIA,
  SCORE_LEVELS
} from "../lib/systemone.js";

/** Candidates used by the pure tests. */
function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    hash: String(index).repeat(40).slice(0, 40),
    title: "entry " + index,
    summary: "summary " + index,
    keywords: ["kw" + index],
    kind: "task"
  }));
}

/** Minimal GateOptions with everything a test needs to override. */
function options(overrides = {}) {
  return {
    endpoint: "https://example.test/v1/systemone",
    model: "jev-latest",
    mode: "noul",
    threshold: 0.5,
    scoreMin: 2,
    minKeep: 1,
    maxCandidates: 20,
    maxTaskChars: 2000,
    timeoutMs: 8000,
    apiKey: "test-key",
    ...overrides
  };
}

/** A fetch stub returning one answer per candidate id. */
function fetchStub(values, init = {}) {
  const calls = [];
  const impl = async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    const answers = {};
    values.forEach((value, index) => {
      answers["m" + index] = value === null ? {} : { type: "noul", noul: value };
    });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => ({ model: "jev-1.13.0", answers, usage: init.usage ?? { input_tokens: 1234, output_tokens: 20 } })
    };
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// request construction
// ---------------------------------------------------------------------------

test("buildRequest asks one noul question per candidate in a single request", () => {
  const body = buildRequest("fix the parser", candidates(3), { mode: "noul", model: "jev-latest", maxTaskChars: 2000 });
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.task, "fix the parser");
  assert.deepEqual(Object.keys(body.questions), ["m0", "m1", "m2"]);
  // Documented contract: a noul `criteria` is an object with true/false keys.
  assert.deepEqual(body.questions.m0.criteria, NOUL_CRITERIA);
  assert.equal(typeof body.questions.m0.criteria, "object");
  assert.equal(body.questions.m0.type, "noul");
  // The official idiom: the candidate travels in that question's instructions.
  assert.equal(body.questions.m1.instructions.candidate.title, "entry 1");
  assert.match(body.questions.m0.instructions.question, /candidate/);
});

test("buildRequest score mode sends an ordered level array (2..10 levels)", () => {
  const body = buildRequest("task", candidates(1), { mode: "score", model: "jev-latest", maxTaskChars: 2000 });
  assert.equal(body.questions.m0.type, "score");
  assert.ok(Array.isArray(body.questions.m0.criteria));
  assert.ok(body.questions.m0.criteria.length >= 2 && body.questions.m0.criteria.length <= 10);
  assert.deepEqual(body.questions.m0.criteria, [...SCORE_LEVELS]);
});

test("buildRequest truncates a task longer than maxTaskChars", () => {
  const body = buildRequest("x".repeat(50), candidates(1), { mode: "noul", model: "m", maxTaskChars: 10 });
  assert.equal(body.state.task.length, 11); // 10 chars + ellipsis
});

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------

test("parseAnswers reads the documented answers envelope", () => {
  const payload = { model: "jev-1.13.0", answers: { m0: { type: "noul", noul: 0.91 }, m1: { type: "noul", noul: 0.02 } } };
  assert.deepEqual(parseAnswers(payload, "noul", 2), [0.91, 0.02]);
});

test("parseAnswers tolerates a bare answer map and missing/malformed answers", () => {
  assert.deepEqual(parseAnswers({ m0: { noul: 0.4 } }, "noul", 1), [0.4]);
  assert.deepEqual(parseAnswers({ answers: { m0: {} } }, "noul", 1), [undefined]);
  assert.deepEqual(parseAnswers({ answers: { m0: { noul: "yes" } } }, "noul", 1), [undefined]);
  assert.deepEqual(parseAnswers(null, "noul", 1), [undefined]);
});

test("parseAnswers reads the score field in score mode", () => {
  assert.deepEqual(parseAnswers({ answers: { m0: { type: "score", score: 3.25 } } }, "score", 1), [3.25]);
});

test("parseUsage maps the endpoint's token accounting", () => {
  assert.deepEqual(parseUsage({ usage: { input_tokens: 300, output_tokens: 12 } }), {
    inputTokens: 300,
    outputTokens: 12
  });
  assert.equal(parseUsage({ usage: {} }), undefined);
  assert.equal(parseUsage({}), undefined);
});

// ---------------------------------------------------------------------------
// decision logic
// ---------------------------------------------------------------------------

test("decide applies the noul threshold", () => {
  const result = decide(candidates(3), [0.9, 0.4, 0.7], options({ threshold: 0.5 }));
  assert.deepEqual(result.kept.sort(), [candidates(3)[0].hash, candidates(3)[2].hash].sort());
  assert.deepEqual(result.dropped, [candidates(3)[1].hash]);
  assert.equal(result.floored, false);
});

test("decide applies the score scale threshold (0..levels-1, not 0..1)", () => {
  const result = decide(candidates(3), [0.5, 2.0, 3.4], options({ mode: "score", scoreMin: 2 }));
  assert.deepEqual(result.dropped, [candidates(3)[0].hash]);
  assert.equal(result.kept.length, 2);
});

test("decide keeps unreadable answers (per-candidate fail-open)", () => {
  const result = decide(candidates(2), [undefined, 0.01], options());
  assert.ok(result.kept.includes(candidates(2)[0].hash));
  assert.equal(result.dropped.length, 1);
});

test("decide retains the top candidates when the model rejects the whole page", () => {
  const result = decide(candidates(4), [0.1, 0.2, 0.05, 0.3], options({ threshold: 0.9, minKeep: 2 }));
  assert.equal(result.kept.length, 2);
  assert.equal(result.floored, true);
  // Highest values win: 0.3 and 0.2.
  assert.deepEqual(result.kept, [candidates(4)[1].hash, candidates(4)[3].hash]);
});

test("decide never empties a page when minKeep is 0 and nothing passes", () => {
  const result = decide(candidates(2), [0.01, 0.02], options({ threshold: 0.9, minKeep: 0 }));
  assert.deepEqual(result.kept, []);
  assert.equal(result.floored, false);
});

// ---------------------------------------------------------------------------
// end-to-end gate evaluation
// ---------------------------------------------------------------------------

test("evaluateGate drops the irrelevant candidates and reports usage", async () => {
  const fetchImpl = fetchStub([0.95, 0.05, 0.8]);
  const decision = await evaluateGate("task", candidates(3), options({ fetchImpl }));
  assert.equal(decision.degraded, false);
  assert.equal(decision.kept.length, 2);
  assert.deepEqual(decision.dropped, [candidates(3)[1].hash]);
  assert.deepEqual(decision.usage, { inputTokens: 1234, outputTokens: 20 });
  // Auth + endpoint come from the settings, never from the caller.
  assert.equal(fetchImpl.calls[0].url, "https://example.test/v1/systemone");
  assert.equal(fetchImpl.calls[0].body.questions.m0.type, "noul");
});

test("evaluateGate fails open on a non-2xx response", async () => {
  const fetchImpl = fetchStub([0.0], { ok: false, status: 500 });
  const decision = await evaluateGate("task", candidates(2), options({ fetchImpl }));
  assert.equal(decision.degraded, true);
  assert.match(decision.reason, /HTTP 500/);
  assert.equal(decision.kept.length, 2);
});

test("evaluateGate fails open when the request throws", async () => {
  const decision = await evaluateGate("task", candidates(2), options({
    fetchImpl: async () => {
      throw new Error("socket hang up");
    }
  }));
  assert.equal(decision.degraded, true);
  assert.match(decision.reason, /socket hang up/);
  assert.equal(decision.kept.length, 2);
  assert.deepEqual(decision.dropped, []);
});

test("evaluateGate fails open when no API key is configured", async () => {
  const decision = await evaluateGate("task", candidates(2), options({ apiKey: undefined }));
  assert.equal(decision.degraded, true);
  assert.match(decision.reason, /no API key/);
  assert.equal(decision.kept.length, 2);
});

test("evaluateGate resolves a late-bound credential when no literal key is set", async () => {
  const fetchImpl = fetchStub([0.9]);
  const decision = await evaluateGate("task", candidates(1), options({
    apiKey: undefined,
    resolveApiKey: async () => "from-credentials",
    fetchImpl
  }));
  assert.equal(decision.degraded, false);
  assert.equal(decision.kept.length, 1);
});

test("evaluateGate only judges the first maxCandidates and keeps the rest", async () => {
  const fetchImpl = fetchStub([0.9, 0.9]);
  const all = candidates(4);
  const decision = await evaluateGate("task", all, options({ fetchImpl, maxCandidates: 2 }));
  assert.equal(fetchImpl.calls[0].body.questions.m2, undefined);
  assert.deepEqual(decision.kept, all.map((c) => c.hash));
  // The reported counts must distinguish "sent for judgement" from "page size".
  assert.equal(decision.judged, 2);
  assert.equal(decision.untouched, 2);
});

test("evaluateGate never drops candidates it did not judge, even when all judged ones are rejected", async () => {
  const fetchImpl = fetchStub([0.1, 0.1]);
  const all = candidates(4);
  // minKeep 0 so the floor cannot mask whether the untouched tail survived.
  const decision = await evaluateGate("task", all, options({ fetchImpl, maxCandidates: 2, minKeep: 0 }));
  assert.equal(decision.judged, 2);
  assert.equal(decision.untouched, 2);
  assert.deepEqual(decision.kept, [all[2].hash, all[3].hash], "unjudged candidates must survive untouched");
  assert.deepEqual(decision.dropped, [all[0].hash, all[1].hash]);
});

test("evaluateGate returns no decision work for an empty page", async () => {
  const decision = await evaluateGate("task", [], options());
  assert.deepEqual(decision, {
    mode: "noul",
    model: "jev-latest",
    kept: [],
    dropped: [],
    verdicts: [],
    judged: 0,
    untouched: 0,
    degraded: false
  });
});

test("evaluateGate records judged/untouched on the fail-open path too", async () => {
  const decision = await evaluateGate(
    "task",
    candidates(4),
    options({ maxCandidates: 2, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
  );
  assert.equal(decision.degraded, true);
  assert.equal(decision.judged, 2);
  assert.equal(decision.untouched, 2);
  assert.equal(decision.kept.length, 4);
});

test("a gate decision stays losslessly JSON-serializable (no NaN)", async () => {
  const fetchImpl = fetchStub([0.9, null]);
  const decision = await evaluateGate("task", candidates(2), options({ fetchImpl }));
  const round = JSON.parse(JSON.stringify(decision));
  assert.deepEqual(round, decision);
  for (const verdict of decision.verdicts) {
    assert.ok(verdict.value === null || Number.isFinite(verdict.value));
  }
});

// ---------------------------------------------------------------------------
// plugin integration: fallback + filtering
// ---------------------------------------------------------------------------

const dirs = [];
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gitmemo-gate-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "gitmemo-test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "gitmemo-test@example.com"], { cwd: dir });
  return dir;
}

/** Load the plugin and return its registered tools for one root agent. */
async function pluginTools(config) {
  const mod = await import("../lib/index.js");
  const registrations = [];
  const handlers = {};
  await mod.apply(
    { on: (event, handler) => { handlers[event] = handler; }, logger: { warn: () => {}, info: () => {} } },
    config
  );
  const agentCtx = { tools: { register: (tool) => registrations.push(tool) }, systemPrompt: { section: () => {} } };
  handlers["agent/created"]({
    agent: { id: "a1", session: { header: { cwd: config.projectRoot, delegationDepth: 0 } }, ctx: agentCtx }
  });
  return Object.fromEntries(registrations.map((tool) => [tool.name, tool]));
}

test("mem_search is unchanged (no gated block) when no system-one key is configured", async () => {
  const root = makeRepo();
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const tools = await pluginTools({ projectRoot: root });
    const exec = { agent: { session: { header: { cwd: root } } } };
    await tools.mem_write.execute(
      { title: "[gate] fallback fixture", summary: "nothing to gate here", keywords: ["gatefallback", "gw1"], content: "body" },
      exec
    );
    const result = await tools.mem_search.execute({ keywords: ["gatefallback"] }, exec);
    assert.equal(result.results.length, 1);
    assert.equal(Object.hasOwn(result, "gated"), false, "unconfigured gate must not touch the result");
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("mem_search applies the gate when a key is configured, and stays JSON-lossless", async () => {
  const root = makeRepo();
  const realFetch = globalThis.fetch;
  try {
    const tools = await pluginTools({
      projectRoot: root,
      systemOne: { enabled: true, endpoint: "https://example.test/v1/systemone", model: "jev-latest", mode: "noul", threshold: 0.5, minKeep: 1, apiKey: "test-key" }
    });
    const exec = { agent: { session: { header: { cwd: root } } } };
    const first = await tools.mem_write.execute(
      { title: "[gate] keep me", summary: "relevant", keywords: ["gatekeep", "gk1"], content: "body" },
      exec
    );
    const second = await tools.mem_write.execute(
      { title: "[gate] drop me", summary: "irrelevant", keywords: ["gatekeep", "gk2"], content: "body" },
      exec
    );
    // Answer by candidate identity (page order is score/hash-tiebroken, so
    // keying on position would make this test order-dependent).
    globalThis.fetch = async (url, request) => {
      const body = JSON.parse(request.body);
      const answers = {};
      for (const [id, question] of Object.entries(body.questions)) {
        const title = question.instructions.candidate.title;
        answers[id] = { type: "noul", noul: title.includes("keep me") ? 0.93 : 0.04 };
      }
      return { ok: true, status: 200, json: async () => ({ answers, usage: { input_tokens: 42, output_tokens: 3 } }) };
    };

    const result = await tools.mem_search.execute({ keywords: ["gatekeep"] }, exec);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].hash, first.hash);
    assert.equal(result.gated.mode, "noul");
    assert.equal(result.gated.model, "jev-latest");
    assert.equal(result.gated.candidates, 2);
    assert.equal(result.gated.judged, 2);
    assert.equal(result.gated.untouched, 0);
    assert.equal(result.gated.kept, 1);
    assert.equal(result.gated.dropped, 1);
    assert.equal(result.gated.degraded, false);
    assert.equal(result.gated.input_tokens, 42);
    assert.deepEqual(result.gated.dropped_hashes, [second.hash.slice(0, 8)]);
    // The dropped memory stays recoverable by its short hash.
    const recovered = await tools.mem_read.execute({ commit_hash: result.gated.dropped_hashes[0] }, exec);
    assert.equal(recovered.commit_hash, second.hash);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the rendered gated line names a floored page and reports the unjudged tail", async () => {
  const root = makeRepo();
  const realFetch = globalThis.fetch;
  try {
    // maxCandidates 1 on a 2-candidate page: exactly one candidate is actually
    // judged, the other is untouched. Every answer is rejected, so minKeep
    // floors the page. Both facts have to be legible in the text the model sees.
    const tools = await pluginTools({
      projectRoot: root,
      systemOne: {
        enabled: true,
        endpoint: "https://example.test/v1/systemone",
        model: "jev-latest",
        mode: "noul",
        threshold: 0.5,
        minKeep: 1,
        maxCandidates: 1,
        apiKey: "test-key"
      }
    });
    const exec = { agent: { session: { header: { cwd: root } } } };
    await tools.mem_write.execute(
      { title: "[gate] floored one", summary: "irrelevant", keywords: ["gatefloor", "gf1"], content: "body" },
      exec
    );
    await tools.mem_write.execute(
      { title: "[gate] floored two", summary: "irrelevant", keywords: ["gatefloor", "gf2"], content: "body" },
      exec
    );
    globalThis.fetch = async (url, request) => {
      const body = JSON.parse(request.body);
      const answers = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.03 };
      return { ok: true, status: 200, json: async () => ({ answers, usage: { input_tokens: 7, output_tokens: 1 } }) };
    };

    const result = await tools.mem_search.execute({ keywords: ["gatefloor"] }, exec);
    assert.equal(result.gated.judged, 1);
    assert.equal(result.gated.untouched, 1);
    assert.equal(result.gated.kept, 2, "the unjudged candidate plus the floored one");
    assert.equal(result.gated.dropped, 0);

    const rendered = tools.mem_search.output.render({ keywords: ["gatefloor"] }, result)[0].text;
    assert.match(rendered, /gated: mode=noul model=jev-latest judged=1 untouched=1 kept=2 dropped=0 /);
    // The floor must be visible: kept=1 without a NOTE is indistinguishable from
    // "one candidate genuinely passed".
    assert.match(rendered, /NOTE\(no candidate scored above the threshold; retained top 1\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the rendered gated line stays unchanged when the whole page was judged", async () => {
  const root = makeRepo();
  const realFetch = globalThis.fetch;
  try {
    const tools = await pluginTools({
      projectRoot: root,
      systemOne: { enabled: true, endpoint: "https://example.test/v1/systemone", model: "jev-latest", mode: "noul", threshold: 0.5, minKeep: 1, apiKey: "test-key" }
    });
    const exec = { agent: { session: { header: { cwd: root } } } };
    await tools.mem_write.execute(
      { title: "[gate] plain keep", summary: "relevant", keywords: ["gateplain", "gp1"], content: "body" },
      exec
    );
    globalThis.fetch = async (url, request) => {
      const body = JSON.parse(request.body);
      const answers = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.97 };
      return { ok: true, status: 200, json: async () => ({ answers }) };
    };

    const result = await tools.mem_search.execute({ keywords: ["gateplain"] }, exec);
    const rendered = tools.mem_search.output.render({ keywords: ["gateplain"] }, result)[0].text;
    // No untouched tail, no reason: byte-identical to the pre-change line.
    assert.match(rendered, /gated: mode=noul model=jev-latest judged=1 kept=1 dropped=0$/m);
    assert.doesNotMatch(rendered, /untouched=|NOTE\(/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mem_search fails open (keeps everything) when the endpoint errors", async () => {
  const root = makeRepo();
  const realFetch = globalThis.fetch;
  try {
    const tools = await pluginTools({
      projectRoot: root,
      systemOne: { enabled: true, endpoint: "https://example.test/v1/systemone", apiKey: "test-key" }
    });
    const exec = { agent: { session: { header: { cwd: root } } } };
    await tools.mem_write.execute(
      { title: "[gate] survive", summary: "irrelevant but must survive", keywords: ["gatesurvive", "gs1"], content: "body" },
      exec
    );
    globalThis.fetch = async () => {
      throw new Error("endpoint unreachable");
    };
    const result = await tools.mem_search.execute({ keywords: ["gatesurvive"] }, exec);
    assert.equal(result.results.length, 1, "a broken endpoint must never hide a memory");
    assert.equal(result.gated.degraded, true);
    assert.match(result.gated.reason, /endpoint unreachable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("systemOne.enabled:false disables the gate even with a key present", async () => {
  const root = makeRepo();
  try {
    const tools = await pluginTools({
      projectRoot: root,
      systemOne: { enabled: false, endpoint: "https://example.test/v1/systemone", apiKey: "test-key" }
    });
    const exec = { agent: { session: { header: { cwd: root } } } };
    await tools.mem_write.execute(
      { title: "[gate] disabled", summary: "no gate", keywords: ["gatedisabled", "gd1"], content: "body" },
      exec
    );
    const result = await tools.mem_search.execute({ keywords: ["gatedisabled"] }, exec);
    assert.equal(result.results.length, 1);
    assert.equal(Object.hasOwn(result, "gated"), false);
  } finally {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});
