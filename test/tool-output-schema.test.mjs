// Every tool result must satisfy the tool's own declared output schema.
//
// The host validates the *detached* (JSON round-tripped) value of every tool
// result against the compiled output schema before it reaches the model, with
// the very validator imported below. A field the runtime emits but the schema
// does not declare therefore turns a working tool into a hard
// `ToolOutputError` — which is exactly what happened to `mem_search`: the
// System-one gate emitted `gated.policy` / `gated.bounded` from commit
// cd96d07 onwards, but the output schema declared neither, so every gated
// search failed with
//   "value.gated.policy" is not a declared property (additionalProperties: false)
// and no candidate page ever reached the model.
//
// These tests assert schema conformance for all five tools, so the same class
// of drift cannot ship silently again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

const dirs = [];

/** A throwaway git repo to hold the `.mem` memory repo. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gitmemo-schema-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "gitmemo-test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "gitmemo-test@example.com"], { cwd: dir });
  return dir;
}

process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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

/**
 * Run the host's own output check on one result: the schema must be the
 * compiled one the tool exposes, and the value must be the detached snapshot
 * the host validates (same as `snapshotToolValue` + `validateJsonSchemaValue`
 * in the tool runtime).
 */
function assertOutputConforms(tools, name, result) {
  const tool = tools[name];
  assert.ok(tool, `${name} must be registered`);
  const detached = JSON.parse(JSON.stringify(result));
  const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
  assert.deepEqual(violations, [], `${name} output must satisfy its declared schema`);
  return detached;
}

test("mem_search output conforms to its schema without the gate", async () => {
  const root = makeRepo();
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const tools = await pluginTools({ projectRoot: root });
    const exec = { agent: { session: { header: { cwd: root } } } };
    const written = await tools.mem_write.execute(
      { title: "[schema] fixture", summary: "schema conformance fixture", keywords: ["schemaconf", "sc1"], content: "body" },
      exec
    );
    assertOutputConforms(tools, "mem_write", written);

    const searched = await tools.mem_search.execute({ keywords: ["schemaconf"] }, exec);
    const detached = assertOutputConforms(tools, "mem_search", searched);
    assert.equal(Object.hasOwn(detached, "gated"), false, "no gate configured => no gated block");
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("the gated mem_search block conforms to its schema under both policies", async () => {
  const realFetch = globalThis.fetch;
  try {
    // `rerank` (the shipped default): every candidate kept, page reordered.
    const rerankRoot = makeRepo();
    const rerankTools = await pluginTools({
      projectRoot: rerankRoot,
      systemOne: { enabled: true, endpoint: "https://example.test/v1/systemone", model: "jev-latest", mode: "noul", apiKey: "test-key" }
    });
    const rerankExec = { agent: { session: { header: { cwd: rerankRoot } } } };
    await rerankTools.mem_write.execute(
      { title: "[schema] reranked one", summary: "s", keywords: ["schemagate", "sg1"], content: "body" },
      rerankExec
    );
    globalThis.fetch = async (url, request) => {
      const body = JSON.parse(request.body);
      const answers = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.2 };
      return { ok: true, status: 200, json: async () => ({ answers, usage: { input_tokens: 3, output_tokens: 1 } }) };
    };
    const reranked = await rerankTools.mem_search.execute({ keywords: ["schemagate"] }, rerankExec);
    assert.equal(reranked.gated.policy, "rerank");
    assertOutputConforms(rerankTools, "mem_search", reranked);

    // `filter` with maxDropFraction 0: the bound fires, so `bounded: true` is
    // part of the emitted value and has to be declared too.
    const filterRoot = makeRepo();
    const filterTools = await pluginTools({
      projectRoot: filterRoot,
      systemOne: {
        enabled: true,
        endpoint: "https://example.test/v1/systemone",
        model: "jev-latest",
        mode: "noul",
        threshold: 0.9,
        minKeep: 0,
        policy: "filter",
        maxDropFraction: 0,
        apiKey: "test-key"
      }
    });
    const filterExec = { agent: { session: { header: { cwd: filterRoot } } } };
    await filterTools.mem_write.execute(
      { title: "[schema] bounded one", summary: "s", keywords: ["schemabound", "sb1"], content: "body" },
      filterExec
    );
    globalThis.fetch = async (url, request) => {
      const body = JSON.parse(request.body);
      const answers = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.01 };
      return { ok: true, status: 200, json: async () => ({ answers, usage: { input_tokens: 3, output_tokens: 1 } }) };
    };
    const bounded = await filterTools.mem_search.execute({ keywords: ["schemabound"] }, filterExec);
    assert.equal(bounded.gated.policy, "filter");
    assert.equal(bounded.gated.bounded, true, "fixture must exercise the bounded field");
    assertOutputConforms(filterTools, "mem_search", bounded);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mem_read / mem_replace / mem_delete outputs conform to their schemas", async () => {
  const root = makeRepo();
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const tools = await pluginTools({ projectRoot: root });
    const exec = { agent: { session: { header: { cwd: root } } } };
    const first = await tools.mem_write.execute(
      { title: "[schema] link target", summary: "target", keywords: ["schemalink", "sl1"], content: "body" },
      exec
    );
    const second = await tools.mem_write.execute(
      {
        title: "[schema] linking entry",
        summary: "links to the first",
        keywords: ["schemalink", "sl2"],
        content: "see [[" + first.hash + "]] and [[deadbeef]]"
      },
      exec
    );

    // expand:true so the `links` array (and its dangling-link `error` field) is
    // part of the value the schema has to cover.
    const read = await tools.mem_read.execute({ commit_hash: second.hash, expand: true }, exec);
    assert.ok(Array.isArray(read.links) && read.links.length > 0, "fixture must exercise the links array");
    assertOutputConforms(tools, "mem_read", read);

    const replaced = await tools.mem_replace.execute(
      {
        commit_hash: second.hash,
        title: "[schema] linking entry v2",
        summary: "replaced",
        keywords: ["schemalink", "sl2"],
        content: "still links to [[" + first.hash + "]]"
      },
      exec
    );
    assertOutputConforms(tools, "mem_replace", replaced);

    const deleted = await tools.mem_delete.execute({ commit_hash: replaced.hash, reason: "schema fixture" }, exec);
    assertOutputConforms(tools, "mem_delete", deleted);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});
