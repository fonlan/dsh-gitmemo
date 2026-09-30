#!/usr/bin/env node
/**
 * Local patch for OmniMemEval's judge-label parser.
 *
 * Upstream inconsistency this fixes (present at commit 0b1ea8d):
 *   - `JUDGE_PROMPT` tells the judge model to "provide a short (one sentence)
 *     explanation of your reasoning, then finish with CORRECT or WRONG";
 *   - `extract_label_json` then requires the output to be EXACTLY
 *     `{"label": "VALUE"}` — a single-key JSON object and nothing else.
 *
 * So any judge reply that carries an explanation (e.g.
 * `{"label": "WRONG", "reasoning": "..."}`) is unparseable, and the instance
 * fails with "could not extract judge label from response". On a full `_S` run
 * that was 37 of 500 instances — 7.4% of the benchmark lost to a regex.
 *
 * The patch is a strict SUPERSET of the accepted formats and never reinterprets
 * a verdict: the original pattern is tried first and returns exactly what it
 * always did; only if it fails do we look for a `"label"` key in any JSON
 * object, and finally for the prose form the prompt itself asks for (a trailing
 * standalone CORRECT/WRONG). The caller does `json.loads(result)["label"]` and
 * compares case-insensitively to "correct", so all three paths are compatible.
 *
 * Applied idempotently by setup.mjs, which marks the result with
 * `PATCH_MARKER` so a re-run is a no-op and an upstream change is detected.
 */
import { readFile, writeFile } from "node:fs/promises";

export const PATCH_MARKER = "# ── patched by dsh-gitmemo evals/omnimemeval/setup.mjs ──";

const UPSTREAM_FUNCTION = `def extract_label_json(text: str) -> str | None:
    """Extract \`\`{"label": "VALUE"}\`\` from LLM grader output."""
    pattern = r'\\{\\s*"label"\\s*:\\s*["\\']([^"\\']*)["\\']\\s*\\}'
    match = re.search(pattern, text)
    if match:
        return match.group(0)
    return None`;

const PATCHED_FUNCTION = `def extract_label_json(text: str) -> str | None:
    """Extract \`\`{"label": "VALUE"}\`\` from LLM grader output."""
    ${PATCH_MARKER}
    # 1. The original strict form, unchanged and tried first.
    pattern = r'\\{\\s*"label"\\s*:\\s*["\\']([^"\\']*)["\\']\\s*\\}'
    match = re.search(pattern, text)
    if match:
        return match.group(0)

    # 2. A "label" key inside a larger JSON object (e.g. one carrying a
    #    "reasoning" field). Upstream's own JUDGE_PROMPT invites an
    #    explanation, so this is the common failure mode.
    loose = re.search(r'"label"\\s*:\\s*["\\']([^"\\']*)["\\']', text)
    if loose:
        return json.dumps({"label": loose.group(1)})

    # 3. The prose form the prompt actually asks for: "... then finish with
    #    CORRECT or WRONG". Prefer a trailing standalone token, then the last
    #    standalone uppercase occurrence.
    stripped = text.strip().rstrip(".*_ \\n\\t")
    trailing = re.search(r'(?:^|\\s)(CORRECT|WRONG)\\s*$', stripped)
    if trailing:
        return json.dumps({"label": trailing.group(1)})
    anywhere = re.findall(r'\\b(CORRECT|WRONG)\\b', text)
    if anywhere:
        return json.dumps({"label": anywhere[-1]})

    return None`;

/**
 * @param {string} path  absolute path to scripts/utils/nlp_metrics.py
 * @returns {Promise<"already-patched"|"patched"|"marker-missing">}
 */
export async function patchJudgeLabelParser(path) {
  const source = await readFile(path, "utf8");
  if (source.includes(PATCH_MARKER)) return "already-patched";
  if (!source.includes(UPSTREAM_FUNCTION)) {
    // Upstream changed the function; do not guess.
    return "marker-missing";
  }
  if (!source.includes("import json")) {
    throw new Error("nlp_metrics.py: expected an `import json` before patching");
  }
  // A replacer FUNCTION, not a replacement string: in a replacement string the
  // sequences `$'`, `$&` and `` $` `` are substitution patterns, and this patch
  // contains regexes ending in `$'` — passing the text directly would splice the
  // rest of the file into the middle of the function.
  const patched = source.replace(UPSTREAM_FUNCTION, () => PATCHED_FUNCTION);
  // Self-check: the patch must have landed verbatim. Catches the substitution
  // hazard above, and any future edit to the template that mangles it.
  for (const needle of [PATCH_MARKER, "\\s*$'", 'return json.dumps({"label": anywhere[-1]})']) {
    if (!patched.includes(needle)) {
      throw new Error(`patch verification failed: patched file is missing ${JSON.stringify(needle)}`);
    }
  }
  if (patched.includes(UPSTREAM_FUNCTION)) {
    throw new Error("patch verification failed: the original function is still present");
  }
  await writeFile(path, patched, "utf8");
  return "patched";
}
