#!/usr/bin/env node
/**
 * Install / refresh the gitmemo backend inside an OmniMemEval checkout.
 *
 * What it does, idempotently:
 *   1. clones OmniMemEval at a pinned commit (default below) into `.omnimemeval/`
 *   2. symlinks this directory's `gitmemo_client.py` into `scripts/client_factory/`
 *   3. adds the two one-line registrations upstream requires for a new backend
 *      (`client_factory/registry.py` and `utils/search_helpers.py` dispatch)
 *   4. symlinks the LongMemEval `_S` split we already downloaded
 *   5. creates a Python 3.12 venv with `uv` (light deps by default; `--full`
 *      adds the torch/bert-score NLP stack that steps 4–5 import)
 *   6. writes an env file for `--env`, with the DeepSeek key resolved from the
 *      environment or the local DSH credential store (never into the repo)
 *
 * Usage:
 *   node evals/omnimemeval/setup.mjs
 *   node evals/omnimemeval/setup.mjs --full --omni /tmp/OmniMemEval
 */
import { execFile, execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keyFromDshCredentials } from "../longmemeval/lib/llm.mjs";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_OMNI = join(REPO_ROOT, ".omnimemeval");
const UPSTREAM = "https://github.com/MemTensor/OmniMemEval";
// Pinned so a run is reproducible; override with --ref to track main.
const PINNED_REF = "0b1ea8d28aa2d3e03ac4a6aee17b3006a131da7d";

const LIGHT_DEPS = ["python-dotenv", "requests", "numpy", "pandas", "tqdm", "rich", "openai", "tiktoken", "pydantic"];
const DATA_DIR = join(REPO_ROOT, "evals", "longmemeval", "data");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) args[token.slice(2, eq)] = token.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    } else args[token.slice(2)] = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const omniDir = resolve(String(args.omni ?? DEFAULT_OMNI));
const ref = String(args.ref ?? PINNED_REF);
const step = (message) => console.log(`\n▸ ${message}`);
const ok = (message) => console.log(`  ✓ ${message}`);
const warn = (message) => console.log(`  ! ${message}`);

async function run(cmd, cmdArgs, opts = {}) {
  return execFileAsync(cmd, cmdArgs, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ── 1. checkout ─────────────────────────────────────────────────────────────
step(`OmniMemEval checkout → ${omniDir}`);
if (!existsSync(join(omniDir, ".git"))) {
  await mkdir(dirname(omniDir), { recursive: true });
  await run("git", ["clone", "-q", UPSTREAM, omniDir]);
  ok("cloned");
} else {
  ok("existing checkout kept");
}
try {
  await run("git", ["-C", omniDir, "fetch", "-q", "origin"]);
} catch {
  warn("git fetch failed (offline?) — using the local checkout as-is");
}
if (ref !== "HEAD") {
  try {
    await run("git", ["-C", omniDir, "checkout", "-q", ref]);
    ok(`checked out ${ref.slice(0, 12)}`);
  } catch (error) {
    warn(`could not check out ${ref}: ${error.message.split("\n")[0]}`);
  }
}
const head = (await run("git", ["-C", omniDir, "rev-parse", "HEAD"])).stdout.trim();
ok(`HEAD = ${head}`);

// ── 2. adapter symlink ──────────────────────────────────────────────────────
step("gateway adapter");
const factoryDir = join(omniDir, "scripts", "client_factory");
const target = join(factoryDir, "gitmemo_client.py");
const source = join(HERE, "gitmemo_client.py");
if (existsSync(target)) {
  ok("scripts/client_factory/gitmemo_client.py already present");
} else {
  await symlink(source, target);
  ok(`symlinked gitmemo_client.py → ${source}`);
}
// The bridge must be reachable from the adapter's own directory, which stays
// this repo's evals/omnimemeval even when the adapter is symlinked.
if (!existsSync(join(omniDir, "scripts", "client_factory", "bridge.mjs")) && !existsSync(join(HERE, "bridge.mjs"))) {
  warn("bridge.mjs is missing next to setup.mjs");
}

// ── 3. upstream registrations ───────────────────────────────────────────────
step("upstream registrations");
const registryPath = join(factoryDir, "registry.py");
let registry = await readFile(registryPath, "utf8");
if (registry.includes('"gitmemo"')) {
  ok("registry.py already knows gitmemo");
} else {
  registry = registry.replace(
    /(\n\s*"mem9":\s*\("mem9_client",\s*"Mem9Client"\),)/,
    '$1\n    "gitmemo":     ("gitmemo_client",     "GitMemoClient"),'
  );
  if (!registry.includes('"gitmemo"')) throw new Error("registry.py: anchor not found — upstream layout changed?");
  await writeFile(registryPath, registry, "utf8");
  ok("registry.py patched");
}

const searchHelpersPath = join(omniDir, "scripts", "utils", "search_helpers.py");
let searchHelpers = await readFile(searchHelpersPath, "utf8");
if (searchHelpers.includes('"gitmemo"')) {
  ok("search dispatch already knows gitmemo");
} else {
  searchHelpers = searchHelpers.replace(
    /(\n\s*"mem9":\s*generic_text_search,)/,
    '$1\n    "gitmemo": generic_text_search,'
  );
  if (!searchHelpers.includes('"gitmemo"')) throw new Error("search_helpers.py: anchor not found — upstream layout changed?");
  await writeFile(searchHelpersPath, searchHelpers, "utf8");
  ok("search dispatch patched");
}

// ── 4. dataset ──────────────────────────────────────────────────────────────
step("LongMemEval dataset");
const dataTarget = join(omniDir, "data", "longmemeval", "longmemeval_s_cleaned.json");
const dataSource = join(DATA_DIR, "longmemeval_s_cleaned.json");
if (existsSync(dataTarget)) {
  ok("dataset already in the checkout");
} else if (existsSync(dataSource)) {
  await symlink(dataSource, dataTarget);
  ok(`symlinked _S split → ${dataSource}`);
} else {
  warn(`_S split not found at ${dataSource}; run \`node evals/longmemeval/run_retrieval.mjs --help\` docs or prepare_longmemeval.py`);
}

// ── 5. venv ─────────────────────────────────────────────────────────────────
const venvDir = join(omniDir, ".venv");
const pythonBin = join(venvDir, "bin", "python");
const wantFull = args.full === true;
if (args["skip-venv"] === true) {
  ok("venv setup skipped (--skip-venv)");
} else {
  step(`Python environment (${wantFull ? "full" : "light"})`);
  if (!existsSync(pythonBin)) {
    try {
      await run("uv", ["venv", "--python", "3.12", venvDir]);
      ok("created .venv with uv (Python 3.12)");
    } catch (error) {
      throw new Error(`uv venv failed: ${error.message}\nInstall uv (brew install uv) or create the venv manually.`);
    }
  } else {
    ok("existing .venv kept");
  }
  const deps = wantFull ? ["-r", join(omniDir, "requirements_user_memory.txt")] : LIGHT_DEPS;
  try {
    await run("uv", ["pip", "install", "-q", "--python", pythonBin, ...deps]);
    ok(wantFull ? "installed requirements_user_memory.txt" : `installed light deps: ${LIGHT_DEPS.join(" ")}`);
    if (!wantFull) {
      warn("steps 4–5 (judge + metrics) also need: transformers bert-score nltk rouge-score sentence-transformers scipy openpyxl — re-run with --full");
    }
  } catch (error) {
    warn(`dependency install failed: ${error.message.split("\n")[0]}`);
  }
}

// ── 6. env file ─────────────────────────────────────────────────────────────
step("env file");
const envOut = resolve(String(args["env-out"] ?? join(homedir(), ".dsh-gitmemo-lme", ".env.gitmemo")));
await mkdir(dirname(envOut), { recursive: true });
let key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) key = await keyFromDshCredentials("DEEPSEEK_API_KEY");
const baseDir = String(args["base-dir"] ?? join(homedir(), ".dsh-gitmemo-lme", "repos"));
const envBody = `# gitmemo × OmniMemEval — generated by evals/omnimemeval/setup.mjs
# ─── gitmemo backend ─────────────────────────────────────────
GITMEMO_BRIDGE_SHARDS=${args.shards ?? 4}
GITMEMO_RPC_TIMEOUT=1800
GITMEMO_LME_BASE_DIR=${baseDir}
GITMEMO_LME_INGEST_KEYWORDS=${args["ingest-keywords"] ?? "idf"}
GITMEMO_LME_QUERY_KEYWORDS=${args["query-keywords"] ?? "plain"}
GITMEMO_LME_INGEST_TEXT=${args["ingest-text"] ?? "user"}
GITMEMO_LME_PAGE_SIZE=20

# ─── runner defaults ─────────────────────────────────────────
LLM_WORKERS=${args["llm-workers"] ?? 8}
TOPK=${args.topk ?? 20}

# ─── ANSWER (answer generation) ──────────────────────────────
ANSWER_MODEL=${args["answer-model"] ?? "deepseek-chat"}
ANSWER_BASE_URL=${args["llm-base-url"] ?? "https://api.deepseek.com/v1"}
ANSWER_API_KEY=${key ?? "${DEEPSEEK_API_KEY}"}

# ─── EVAL (LLM-as-Judge) ─────────────────────────────────────
EVAL_MODEL=${args["eval-model"] ?? "deepseek-chat"}
EVAL_BASE_URL=${args["llm-base-url"] ?? "https://api.deepseek.com/v1"}
EVAL_API_KEY=${key ?? "${DEEPSEEK_API_KEY}"}
`;
await writeFile(envOut, envBody, "utf8");
await chmod(envOut, 0o600);
ok(`wrote ${envOut} (chmod 600)`);
if (!key) warn("no DeepSeek key found — the env file references ${DEEPSEEK_API_KEY}; export it before running");
else ok("DeepSeek key embedded from the environment / local DSH credential store");

// ── summary ─────────────────────────────────────────────────────────────────
const runner = `cd ${omniDir} && ./scripts/run_lme_eval.sh --lib gitmemo --env ${envOut}`;
console.log(`
${"=".repeat(72)}
gitmemo backend installed. Smoke test (ingest + search for one conversation):

  ${runner} --streaming 1 --start-idx 0 --end-idx 0 --to-step 2 --version smoke_gitmemo

Then the full pipeline (step 4+ needs the --full dependency set):

  ${runner} --streaming 1 --version gitmemo_v1

Prefer running python directly while iterating:

  ${pythonBin} scripts/longmemeval/lme_ingestion.py --help
${"=".repeat(72)}`);
