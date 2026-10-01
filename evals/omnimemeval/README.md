# gitmemo backend for OmniMemEval

[OmniMemEval](https://github.com/MemTensor/OmniMemEval) is a memory-evaluation framework whose
*User Memory Evaluation* line wraps several benchmarks — including LongMemEval — behind one
adapter contract and one 6-step pipeline:

```
ingest (add) → search → answer (ANSWER LLM) → judge (EVAL LLM) → metrics → report
```

This directory plugs **`dsh-gitmemo`** into that contract as a new backend, `--lib gitmemo`. The
result is a QA-accuracy number comparable to published LongMemEval results, with ingest, search,
answer generation, LLM-as-judge, aggregation and the report all handled by upstream code.

For the *retrieval* metrics gitmemo is measured with separately (recall/NDCG, no LLM in the
loop), see [`../longmemeval/README.md`](../longmemeval/README.md). The two tracks are
complementary, not redundant.

The installed checkout is pinned to upstream commit
`0b1ea8d28aa2d3e03ac4a6aee17b3006a131da7d` for reproducibility. OmniMemEval is Apache-2.0;
third-party benchmark data keeps its own upstream licence.

---

## 1. The adapter, and why it is a Node bridge

OmniMemEval is Python and expects

```python
client.add(messages, user_id, session_id=...)   # ingest one session
client.search(query, user_id, top_k)            # return context text
client.delete(user_id)                          # drop that user's memory
```

gitmemo's engine is TypeScript (`lib/mem.js`), so `gitmemo_client.py` keeps the Python side as
pure transport and speaks JSON-lines to a persistent Node process, `bridge.mjs`, over
stdin/stdout — no HTTP server and no port to manage. Everything gitmemo-specific lives on the
Node side, where the real engine and the keyword strategies already are.

```
OmniMemEval (Python)            bridge.mjs (Node)                    engine
  lme_ingestion.py  ──add()──▶  per-session keyword/summary  ──▶  GitMemo.write()
  lme_search.py     ──search()▶  query→keywords, mem_search,  ──▶  GitMemo.search()/read()
                                mem_read → context text
```

One `.mem` repository per `user_id` (OmniMemEval uses one user per conversation), so memories
never leak across benchmark conversations. State is on disk, so a later pipeline step — a fresh
Python process, a fresh bridge — **reattaches instead of re-ingesting**; this is what lets
`--from-step`/`--to-step`, `--replay` and the streaming checkpoint/resume work.

`gitmemo_client.py` spreads users across `GITMEMO_BRIDGE_SHARDS` bridge processes (default 4) by
hashing `user_id`, so the two largest stages (ingest, search) keep several cores busy.

### The interface obligations the adapter discharges

gitmemo is not a `search(text)` vector store, and OmniMemEval hands over whole sessions and raw
questions, so the adapter must supply what an agent normally would:

| Direction | OmniMemEval gives | gitmemo needs | Adapter does |
| --- | --- | --- | --- |
| ingest | a session's messages | `mem_write` with a title, a non-empty summary and 2–12 keywords | writes them per session (strategy configurable, §2), records the transcript as the entry body |
| search | a natural-language question | `mem_search` with 1–15 keywords, greps **only** the commit-message projections | extracts query keywords, pages `mem_search`, `mem_read`s each hit, returns bodies as plain text |
| delete | `user_id` | — | removes that user's `.mem` repository |

Returning the entry *bodies* (not just titles) matters: gitmemo stores the full session
transcript as the entry body, so a hit is as informative as any other backend's retrieved chunk —
while recall itself still depends only on the projections. `formatMemory()` strips the YAML front
matter (format version, branch, digest — pure prompt noise) and de-duplicates the summary when it
is already contained in the body.

---

## 2. Configuration

`setup.mjs` writes an env file (default `~/.dsh-gitmemo-lme/.env.gitmemo`, `chmod 600`); the
DeepSeek key is resolved from the environment or the local DSH credential store and is **never**
written back into the checkout.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITMEMO_LME_BASE_DIR` | `~/.dsh-gitmemo-lme/repos` | where the per-user `.mem` repos live |
| `GITMEMO_BRIDGE_SHARDS` | `4` | concurrent bridge processes, routed by `user_id` |
| `GITMEMO_RPC_TIMEOUT` | `1800` | seconds per RPC before failing |
| `GITMEMO_LME_INGEST_KEYWORDS` | `idf` | `idf` (deterministic, no key) or `llm` (an LLM writes each memory — what a real agent does) |
| `GITMEMO_LME_QUERY_KEYWORDS` | `plain` | `plain`, `idf` or `llm` |
| `GITMEMO_LME_SUMMARY` | `extractive` | `extractive` or `prefix` |
| `GITMEMO_LME_KEYWORD_SCORE` | `bm25` | `bm25` (saturated) or `tfidf` |
| `GITMEMO_LME_INGEST_TEXT` | `user` | `user` turns only, or `all` (user + assistant) |
| `GITMEMO_LME_READ_BODIES` | `1` | `0` returns only titles/summaries as context |

Why `extractive` and `bm25` rather than the naive settings, and what they changed, is documented
in [`../longmemeval/README.md` §3](../longmemeval/README.md) with the failing case.

### Changing the strategy without re-ingesting

The ingestion policy is baked into the memories at write time, so changing
`GITMEMO_LME_INGEST_KEYWORDS` requires a fresh run (`--no-resume`, or a new `--version`). Query-side
knobs (`GITMEMO_LME_QUERY_KEYWORDS`, `--top-k`) can be re-run alone against existing repositories
with `--from-step 2`, because the repos persist.

---

## 3. Install and run

```bash
# 1. clone (pinned commit) + adapter symlink + upstream registrations + venv + env file
node evals/omnimemeval/setup.mjs

# 2. activate for the run (the upstream runner calls bare `python`)
export PATH="$PWD/.omnimemeval/.venv/bin:$PATH"

# 3. smoke: one conversation, ingest + search only
cd .omnimemeval && ./scripts/run_lme_eval.sh --lib gitmemo \
  --env ~/.dsh-gitmemo-lme/.env.gitmemo \
  --streaming 1 --start-idx 0 --end-idx 0 --to-step 2 --version smoke_gitmemo
```

`setup.mjs` is idempotent and performs the four registrations upstream requires for a new backend, plus one local bug-fix patch:

1. symlinks `gitmemo_client.py` into the checkout's `scripts/client_factory/`;
2. registers `"gitmemo" → GitMemoClient` in `client_factory/registry.py`;
3. registers `"gitmemo": generic_text_search` in `utils/search_helpers.py`'s dispatch table
   (`client.search(query, user_id, top_k)` already matches the generic wrapper);
4. symlinks the `longmemeval_s_cleaned.json` split already downloaded by the sibling harness, and
   creates the venv;
5. patches `utils/nlp_metrics.py`'s judge-label parser, which otherwise discards 7.4 % of
   instances — see §4.

The backend registrations are anchored to the lines upstream's own comment block names as the
place to add a lib. Every step **fails loudly** rather than silently if the upstream layout has
moved, and the judge patch additionally self-verifies that it landed verbatim.

### Dependency tiers

`setup.mjs` installs the light tier by default — enough for steps 1–3 (ingest, search, answer),
which is where the gitmemo work is:

```
python-dotenv requests numpy pandas tqdm rich openai tiktoken pydantic
```

Steps 4–5 (LLM-as-judge and metric aggregation) additionally `import transformers`, `bert_score`,
`nltk`, `rouge_score`, `sentence_transformers`, `scipy` and `openpyxl` — a multi-GB torch
download plus model weights on first use. Add them with:

```bash
node evals/omnimemeval/setup.mjs --full
```

There is no `conda` on this machine; `setup.mjs` uses `uv` to build a Python 3.12 venv at
`.omnimemeval/.venv`, which is what upstream's `requirements_user_memory.txt` targets.

### Full pipeline

```bash
cd .omnimemeval && ./scripts/run_lme_eval.sh --lib gitmemo \
  --env ~/.dsh-gitmemo-lme/.env.gitmemo \
  --streaming 1 --version gitmemo_v1
```

`--streaming 1` runs add → search → answer → judge → delete per conversation, which keeps disk
use bounded (rather than holding all 500 conversations' repos at once), makes partial progress
resumable, and is the mode upstream recommends for LongMemEval. Results land in
`results/lme/gitmemo-<version>/`.

Useful upstream flags: `--to-step 2` (ingest+search only), `--from-step 3` (re-run the LLM stages
against already-ingested memories), `--start-idx/--end-idx` (slice the conversations),
`--llm-workers N`, `--top-k N`, `--replay <dir>`, `--no-resume`, `--restart-unit 1`.

---

## 4. Results

**Full `_S` split, streaming mode, 500/500 conversations, zero failures.** Step 1 (ingest +
search) took 51 min; steps 3–5 took ~1 min. `TOPK=20`, `idf` ingestion, `plain` queries.

| Metric | Value |
| --- | --- |
| **LLM-as-Judge (overall)** | **0.7860** |
| Judge model | `deepseek-chat` (the API serves it as `deepseek-flash`) |
| Answer model | `deepseek-chat` → `deepseek-flash` |
| Context tokens (avg / question) | 19 030 |
| Retrieved context (median / question) | 77 824 chars |
| Search latency (avg / p95) | 370 ms / 720 ms |
| Search status | 494 non-empty, 6 empty, 0 failed |

By question type:

| Category | LLM-Judge | Questions |
| --- | --- | --- |
| single-session-assistant | 0.9464 | 56 |
| single-session-user | 0.8857 | 70 |
| knowledge-update | 0.8333 | 78 |
| temporal-reasoning | 0.8271 | 133 |
| single-session-preference | 0.7000 | 30 |
| multi-session | **0.6165** | 133 |

```bash
cd .omnimemeval && ./scripts/run_lme_eval.sh --lib gitmemo \
  --env ~/.dsh-gitmemo-lme/.env.gitmemo --streaming 1 --llm-workers 12 --version gmf500
```

### What this says

`multi-session` is the weak point, and it is the *same* weak point the retrieval harness finds
(session-level `recall_all@5` 0.554 with `idf` ingestion, the lowest of any category): those 133
questions need several sessions retrieved *together*, and gitmemo's recall returns a broad
keyword-OR match whose ranking cannot guarantee that. The two independent measurements agreeing
is the useful signal.

**Cross-track finding: the official retrieval metric is degenerate exactly where end-to-end
performance is best.** `single-session-assistant` scores 0.9464 here — the highest category —
while the sibling harness reports its session-level retrieval metrics as meaningless because
51 of its 56 instances are gold-free (the evidence is in *assistant* turns, and upstream's gold
rule only accepts a flag on a *user* turn). The end-to-end pipeline succeeds anyway, because
gitmemo stores the whole session transcript as the entry body, so once a hit is found the answer
model can read the assistant's turn. A per-category retrieval table would have written that
category off; measuring both layers shows why it must not be.

**Read the number with its model attached.** Published LongMemEval figures are usually judged by
GPT-4o; this run is judged by DeepSeek's flash tier, so 0.7860 is an internal, reproducible
baseline to iterate against, not a leaderboard claim. The judge is part of the measurement.

### The System-one gate, measured through the pipeline

With the gate wired into `mem_search` exactly as the plugin applies it, on the
identical ingested memories:

| Arm | configuration | LLM-as-Judge | context tokens |
| --- | --- | --- | --- |
| baseline | `idf` ingestion, no gate | 0.7860 | 19 030 |
| A | `llm` ingestion, no gate | 0.7840 | 16 426 |
| B | as A, gate **filtering** at t=0.5 (shipped) | **0.3800** | **3 862** |
| C | as A, gate **reranking** (`GITMEMO_LME_GATE_RERANK=1`) | **0.8020** | 16 426 |

Filtering cuts context by 80 % and accuracy by 52 % — the accuracy cost the
retrieval harness predicts. Reranking cannot drop a memory by construction, so it
keeps accuracy and gains a little, at the price of the context saving. The offline
sweep in `../longmemeval/README.md` shows why: the judge's AUC is ~0.71–0.75, so no
threshold is safe, but the same value is a usable ordering feature. A bounded
filter (never drop more than 20 % of a page) is the untested middle ground.

`GITMEMO_LME_GATE_RERANK` defaults to `1`; set it to `0` to reproduce the shipped
filtering behaviour.

### The judge parser patch (and why it is here)

Upstream `0b1ea8d` is internally inconsistent: `JUDGE_PROMPT` instructs the judge to *"provide a
short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG"*, while
`extract_label_json` accepts only the exact single-key form `{"label": "VALUE"}` and nothing else.
So any judge reply that carries the explanation it was asked for is unparseable, and the whole
instance fails: **37 of 500 (7.4%) were lost that way** before the patch, with `--skip-failed-judge
0` aborting the run.

`patch-judge-label.mjs` (applied automatically by `setup.mjs`, idempotent, self-verifying)
accepts a strict **superset**: the original pattern first and unchanged, then a `"label"` key
inside any JSON object, then the prose form the prompt itself asks for. It never reinterprets a
verdict, and a genuinely unparseable reply still returns `None`, so real failures still surface.
With it, `eval` status is `success=500`.

> If you would rather not carry a local patch, re-run with `--skip-failed-judge 1` to get metrics
> over 463 of 500 instances instead — upstream's own documented flag. The patched number is the
> complete one; the decision is recorded here so either is defensible.

## 5. Reading the output

`results/lme/gitmemo-<version>/` contains the search contexts
(`gitmemo_lme_search_results.json`), generated answers, judge verdicts and — after step 5 — the
aggregate `gitmemo_lme_metrics.json` / Excel export. The headline number is `llm_judge_score`,
broken down by LongMemEval question type.

Two things to keep in mind when interpreting it:

- **Answer accuracy is not retrieval accuracy.** gitmemo's recall surface is the title/summary/
  keywords the writer produced; if the answer is wrong it may be because the memory never
  recorded the fact, not because grep failed. The sibling retrieval harness separates those.
- **The judge model is part of the measurement.** `EVAL_MODEL` defaults to `deepseek-chat` here;
  published LongMemEval numbers are usually judged by GPT-4o, so scores are not strictly
  comparable across judge models. Record the judge with any number that is quoted.

## 6. Known limitations

- **Per-conversation repos.** Ingesting all 500 conversations leaves 500 `.mem` repositories on
  disk (fine at `_S` scale; both this and the retry/rebuild cost matter at `_M` scale).
- **`add()` is synchronous per session.** gitmemo writes one git commit per memory, so ingestion
  is slower than a hosted API's batch `add` — the shard setting is the main lever. This is
  inherent to a git-backed store and is itself a measured cost (see the latency fields upstream
  records per step).
- **The `llm` ingestion strategies cost one chat call per session** (≈24 000 sessions for a full
  `_S` run) or one per question. Responses are cached on disk by request hash, so re-running an
  ablation is free.
