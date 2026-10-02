/**
 * Tests for the settings card's field vocabulary.
 *
 * These pin the rules that decide whether a draft is written, cleared, or
 * *blocks the save* — the difference between a typo being rejected and a typo
 * silently reconfiguring the recall gate. The specs live in a browser-free
 * module precisely so they can be tested here; the browser bundle cannot be
 * imported by Node.
 *
 * Run with:  node --test test/form-specs.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  pathTextField,
  pathNumberField,
  pathBooleanField,
  pathChoiceField,
  pathBoundedNumberField
} = await import("../lib/client/form-specs.js");

/** The staged write a spec produces for a draft, or undefined when it blocks. */
const parse = (spec, text) => spec.parse(text);

// ── the pre-existing specs, as a regression baseline ────────────────────────

test("pathTextField: trims, clears on blank, blocks nothing", () => {
  const spec = pathTextField("endpoint", ["systemOne", "endpoint"]);
  assert.deepEqual(parse(spec, "  https://x.test  "), { kind: "set", value: "https://x.test" });
  assert.deepEqual(parse(spec, "   "), { kind: "clear" });
  assert.equal(spec.format("https://x.test"), "https://x.test");
  assert.equal(spec.format(undefined), "");
});

test("pathBooleanField renders the declared default while the section is absent", () => {
  const spec = pathBooleanField("enabled", ["systemOne", "enabled"]);
  // `src/index.ts` declares default(true): blank must NOT render as "off".
  assert.equal(spec.format(undefined), "true");
  assert.equal(spec.format(true), "true");
  assert.equal(spec.format(false), "false");
  assert.deepEqual(parse(spec, "false"), { kind: "set", value: false });
  assert.equal(parse(spec, "yes"), undefined, "anything else blocks the save");
});

// ── policy: a closed set of strings ─────────────────────────────────────────

test("pathChoiceField renders the declared default while the section is absent", () => {
  const spec = pathChoiceField("policy", ["systemOne", "policy"], ["rerank", "filter"], "rerank");
  // The gate's declared default is rerank: a blank control would misreport the
  // configuration actually in force.
  assert.equal(spec.format(undefined), "rerank");
  assert.equal(spec.format("filter"), "filter");
  assert.equal(spec.format("nonsense"), "rerank", "an unknown stored value falls back to the declared default");
});

test("pathChoiceField accepts exactly the declared values and clears on blank", () => {
  const spec = pathChoiceField("policy", ["systemOne", "policy"], ["rerank", "filter"], "rerank");
  assert.deepEqual(parse(spec, "rerank"), { kind: "set", value: "rerank" });
  assert.deepEqual(parse(spec, "filter"), { kind: "set", value: "filter" });
  assert.deepEqual(parse(spec, "  filter  "), { kind: "set", value: "filter" }, "drafts are trimmed");
  assert.deepEqual(parse(spec, ""), { kind: "clear" }, "blank clears back to the declared default");
  for (const bad of ["Rerank", "drop", "true", "1", "re-rank"]) {
    assert.equal(parse(spec, bad), undefined, `${bad} must block the save, not be silently dropped`);
  }
});

test("pathChoiceField refuses a default that is not an accepted value", () => {
  // A mis-declared default would render a value the field then rejects on save.
  assert.throws(
    () => pathChoiceField("policy", ["systemOne", "policy"], ["rerank", "filter"], "bogus"),
    /not an accepted value/
  );
});

test("pathChoiceField carries the path it was given, for the nested namespace", () => {
  const spec = pathChoiceField("policy", ["systemOne", "policy"], ["rerank", "filter"], "rerank");
  assert.deepEqual(spec.path, ["systemOne", "policy"]);
  assert.equal(spec.field, "policy");
});

// ── maxDropFraction: a bounded number ───────────────────────────────────────

test("pathBoundedNumberField renders the declared default while the section is absent", () => {
  const spec = pathBoundedNumberField("maxDropFraction", ["systemOne", "maxDropFraction"], {
    min: 0,
    max: 1,
    declaredDefault: "0.25"
  });
  assert.equal(spec.format(undefined), "0.25");
  assert.equal(spec.format(0.5), "0.5");
  assert.equal(spec.format(0), "0", "zero is a value, not an absent field");
});

test("pathBoundedNumberField enforces the range at the spec, not the control", () => {
  const spec = pathBoundedNumberField("maxDropFraction", ["systemOne", "maxDropFraction"], {
    min: 0,
    max: 1,
    declaredDefault: "0.25"
  });
  assert.deepEqual(parse(spec, "0"), { kind: "set", value: 0 });
  assert.deepEqual(parse(spec, "1"), { kind: "set", value: 1 });
  assert.deepEqual(parse(spec, "0.25"), { kind: "set", value: 0.25 });
  assert.deepEqual(parse(spec, ""), { kind: "clear" });
  // Outside the range or not a number: block the save so the plane never sees it.
  for (const bad of ["-0.1", "1.1", "2", "abc", "1e3", "NaN", "Infinity"]) {
    assert.equal(parse(spec, bad), undefined, `${bad} must block the save`);
  }
});

test("the two gate fields use the paths the host schema declares", () => {
  // `src/index.ts` nests both under `systemOne`; a dotted single-segment path
  // would write a literal key and silently configure nothing.
  const policy = pathChoiceField("policy", ["systemOne", "policy"], ["rerank", "filter"], "rerank");
  const fraction = pathBoundedNumberField("maxDropFraction", ["systemOne", "maxDropFraction"], {
    min: 0,
    max: 1,
    declaredDefault: "0.25"
  });
  assert.deepEqual(policy.path, ["systemOne", "policy"]);
  assert.deepEqual(fraction.path, ["systemOne", "maxDropFraction"]);
  assert.deepEqual(pathNumberField("x", ["a", "b"]).path, ["a", "b"]);
});

test("the defaults the card shows match the defaults the host schema declares", async () => {
  // Read the host half's own schema defaults, so the two cannot drift apart.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /policy: z\.union\(\["rerank", "filter"\]\)\.default\("rerank"\)/);
  assert.match(source, /maxDropFraction: z\.number\(\)\.min\(0\)\.max\(1\)\.default\(0\.25\)/);
  const policy = pathChoiceField("policy", ["systemOne", "policy"], ["rerank", "filter"], "rerank");
  const fraction = pathBoundedNumberField("maxDropFraction", ["systemOne", "maxDropFraction"], {
    min: 0,
    max: 1,
    declaredDefault: "0.25"
  });
  assert.equal(policy.format(undefined), "rerank");
  assert.equal(fraction.format(undefined), "0.25");
});
