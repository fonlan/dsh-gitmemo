# Changelog

The compatibility line lists the DSH host range this version supports.

## 0.5.3

**Compatibility**: unchanged — dsh `^0.1.7-alpha.1 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` — verified on dsh web `0.2.1-alpha.1`.

**Fixed**
- `mem_search` no longer fails the host's tool-output validation whenever the System-one gate runs. `cd96d07` (shipped in 0.5.0) made the gate report `gated.policy` and `gated.bounded`, but the tool's declared output schema (`additionalProperties: false`) declared neither — and the host validates every result against that schema before it reaches the model. Every gated search therefore ended as `invalid output: "value.gated.policy" is not a declared property (additionalProperties: false)`, so no page was ever delivered. Both fields are now declared (`policy` required, `bounded` optional).
- Regression coverage: `test/tool-output-schema.test.mjs` runs the host's own `validateJsonSchemaValue` over the results of all five tools, including gated searches under both policies. Reverting the schema fix fails it with exactly the reported error.

**Note**: the gate is opt-in (it needs a credential), which is why 0.5.0–0.5.2 shipped with it unusable.

**Verified**: `build` / `typecheck` / `test` (141 pass, +3) all green; the rebuilt module was additionally loaded inside a running dsh web host, where a gated value carrying `policy` + `bounded` validated with zero violations.

## 0.5.2

**Compatibility**: dsh `^0.1.7-alpha.1 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` — verified on dsh web `0.2.1-alpha.1` and DSH Desktop `0.2.0-rc.2`.

**Changed**
- Build baseline moved from `0.2.0-rc.1` to `0.2.1-alpha.1` for every `@deepseek-ai/*` pin (`@deepseek-ai/cordis` `4.0.5-alpha.1`, `@deepseek-ai/schemastery` `3.18.5-alpha.1`).
- Appended `|| ^0.2.1-alpha.1` to every `@deepseek-ai/dsh*` peer range.
- Added the missing `peerDependencies` block. This package declared none, so the host compatibility gate had nothing to evaluate and could never refuse it.
- Unified on pnpm and removed `package-lock.json`: the repository recorded three different cohorts at once (`^0.1.7-alpha.1` in package.json, `0.1.7-alpha.2` in the npm lock, `dsh-tools@0.1.2-alpha.2` in the pnpm lock, and `0.2.0-rc.1` on disk).
- README: declared floor is now dsh >= 0.1.7-alpha.1 (or 0.2.x).

**Verified**: `pnpm install` / `typecheck` / `build` / `test` (138) all green; cold boot in an isolated profile against a real `0.2.1-alpha.1` host passes.
