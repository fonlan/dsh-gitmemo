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

`setup.mjs` is idempotent and performs the four edits upstream requires for a new backend:

1. symlinks `gitmemo_client.py` into the checkout's `scripts/client_factory/`;
2. registers `"gitmemo" → GitMemoClient` in `client_factory/registry.py`;
3. registers `"gitmemo": generic_text_search` in `utils/search_helpers.py`'s dispatch table
   (`client.search(query, user_id, top_k)` already matches the generic wrapper);
4. symlinks the `longmemeval_s_cleaned.json` split already downloaded by the sibling harness, and
   creates the venv.

Both source patches are anchored to the lines upstream's own comment block names as the place to
add a lib, and **fail loudly** rather than silently if the upstream layout has moved.

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

## 4. Reading the output

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

## 5. Known limitations

- **Per-conversation repos.** Ingesting all 500 conversations leaves 500 `.mem` repositories on
  disk (fine at `_S` scale; both this and the retry/rebuild cost matter at `_M` scale).
- **`add()` is synchronous per session.** gitmemo writes one git commit per memory, so ingestion
  is slower than a hosted API's batch `add` — the shard setting is the main lever. This is
  inherent to a git-backed store and is itself a measured cost (see the latency fields upstream
  records per step).
- **The `llm` ingestion strategies cost one chat call per session** (≈24 000 sessions for a full
  `_S` run) or one per question. Responses are cached on disk by request hash, so re-running an
  ablation is free.
