# LongMemEval evaluation for gitmemo

Two complementary ways to measure [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
against the real `dsh-gitmemo` engine (`lib/mem.js` — the same artifact the plugin ships,
not a re-implementation):

| Track | What it measures | Entry point | Needs an LLM |
| --- | --- | --- | --- |
| **Retrieval harness** (this directory) | LongMemEval's *official* retrieval metrics: session- and turn-level `recall_any/recall_all/ndcg_any` @ 1/3/5/10/30/50, bucketed by question type | `run_retrieval.mjs` | No (deterministic keyword strategies) |
| **OmniMemEval pipeline** (`../omnimemeval/`) | End-to-end QA accuracy (`llm_judge_score`) through a 6-step ingest→search→answer→judge→metric→report pipeline | `setup.mjs` then upstream's `run_lme_eval.sh` | Yes (answer + judge) |

The two answer different questions. The harness isolates the **memory layer** — can gitmemo
surface the evidence at all, and at what rank — with no LLM in the loop, so it is cheap,
deterministic and diagnostic. OmniMemEval measures whether the whole loop produces the right
*answer*, which is the number comparable to published LongMemEval results.

An earlier in-conversation report of this work lives in the session; this file is the
authoritative description of the harness itself.

---

## 1. Why an adapter is needed at all

gitmemo is not a vector store with a `search(text)` method. Two of its properties define the
whole shape of this harness:

1. **Recall reads commit messages only.** `GitMemo.search` runs
   `git log --grep --fixed-strings` over the commit-message projections — the entry's
   **title, summary and keywords**. Entry bodies are *never* scanned. So the memory's
   retrieval surface is exactly what the writer put in those three fields, capped at
   12 keywords per entry.
2. **Writing requires keywords.** `mem_write` rejects an entry with fewer than 2 keywords and
   more than 12, and requires a non-empty single-line title and a non-empty summary.

LongMemEval, meanwhile, hands over whole sessions (ingestion) and raw natural-language
questions (search). So the missing piece is exactly what an *agent* normally supplies: the
choice of title, summary and keywords. Both tracks therefore implement that choice behind a
named strategy, and every run records which one it used, so a number is never reported without
the ingestion policy that produced it.

### The strategies

| Knob | Values | Meaning |
| --- | --- | --- |
| `--ingest-keywords` | `idf` (default), `llm` | `idf` = deterministic heuristic over the item text; `llm` = one chat call per session writing a title/summary/keywords, i.e. what a real agent does |
| `--query-keywords` | `plain` (default), `idf`, `llm` | how the *question* becomes 1–15 query keywords |
| `--summary` | `extractive` (default), `prefix` | how the summary is chosen (see §3) |
| `--keyword-score` | `bm25` (default), `tfidf` | keyword ranking: saturated or plain tf×idf (see §3) |

`idf`/`plain`/`extractive`/`bm25` are the defaults, so the default run needs **no API key**.

> **Attribution caveat.** The deterministic strategies compute IDF over the *whole* instance
> corpus, whereas a real online ingestion step could only use history-so-far statistics. That
> is a mild, uniform advantage shared by every retriever compared here, not a gitmemo-specific
> one. (The OmniMemEval bridge, which ingests strictly session-by-session, updates its document
> frequencies *after* choosing each session's keywords so a session can never tune its own
> terms with hindsight.)

---

## 2. Dataset facts that change the numbers

The released cleaned splits
([`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned))
need two things checked before any metric means anything.

**The official gold rule is stricter than the dataset field.** Upstream builds gold as
`[id for id in corpus_ids if "answer" in id]` over the corpus it constructs, and its
`process_item_flat_index` *relabels* a session whose id contains `answer` but which holds no
user turn with `has_answer: true` by replacing `answer` → `noans`. The consequence: a session is
gold only if it has both the id marker **and** a flagged evidence turn. On the released splits
that excludes **145 sessions** that `answer_session_ids` still lists:

| Split | Sessions total | ids containing `answer` | of those, not gold | `answer_session_ids` over-lists |
| --- | --- | --- | --- | --- |
| `oracle` | 948 | 948 | 145 | 145 |
| `_S` | 23 867 | 948 | 145 | 145 |

Using the `answer_session_ids` field instead — the obvious, documented-looking choice — would
penalise a *correct* retriever for ranking those 145 sessions. This harness follows upstream.

**Answer sessions hold ~6× more flagged turns than sessions.** 842 flagged user turns live in
948 sessions, so most gold sessions contain exactly one piece of evidence.

Other numbers worth keeping in view when reading a score:

- `_S` = ~48 sessions per instance (38–62), 23 867 sessions and 122 416 user turns in total.
  500 instances, 30 of them abstention (`_abs`).
- **51 non-abstention instances have no gold document at all** (21 of the 30 abstention
  instances do either). Recall/NDCG treat them exactly as upstream does: `recall_any` counts as
  0 (`any([]) == False`) while `recall_all` counts as 1 (`all([]) == True`). This is why
  `recall_any` can sit *below* `recall_all` in the tables — it is upstream behaviour, not a bug.
  The report always prints the gold-free count next to the averages, and a `gold_only` mean
  restricted to instances that have gold is also computed.
- `oracle` is not a discriminating benchmark: each instance carries only its 2–6 evidence
  sessions, so every retriever lands at ~0.99. It is useful as a wiring check and a ceiling,
  not as a result.
- **`single-session-assistant` is effectively unscoreable at session level.** Those questions ask
  what the *assistant* said, and the flagged evidence turns are assistant turns — 51 sessions
  carry a flagged assistant turn against only 5 with a flagged user turn. Because upstream builds
  the session corpus from user turns only *and* requires the flag on a user turn, **51 of that
  category's 56 instances end up gold-free**: 0 on `recall_any`/`ndcg` but 1 on `recall_all`. The
  category's numbers are an artefact of the gold rule, not a statement about any memory system —
  do not compare systems on it. (Upstream behaviour reproduced faithfully, not a harness bug, but
  worth knowing before quoting a per-category table.) Gold-free counts: 51/56
  `single-session-assistant`, 8/133 `multi-session`, 6/78 `knowledge-update`, 6/70
  `single-session-user`, 1/133 `temporal-reasoning`, 0/30 `single-session-preference`, plus 21 of
  the 30 abstention instances.
- **The dataset is stored in contiguous category blocks**, so `--limit`/`--offset` slices are
  category-biased: indices 0–69 are all `single-session-user`, 70–161 `multi-session` +
  `single-session-preference`, 162–232 `multi-session`, 233–365 `temporal-reasoning`, 366–443
  `knowledge-update`, 444–499 `single-session-assistant`. Use `--seed N` for a representative
  sample, or run all 500.

---

## 3. What the first runs exposed

Both findings are properties of a keyword-grep memory, and both were found by running rather
than by reasoning. They are the reason `--summary` and `--keyword-score` exist.

**A prefix summary buries deep evidence.** With the naive settings (`--summary prefix`,
`--keyword-score tfidf`), question `e47becba` ("What degree did I graduate with?") retrieved
**nothing**. The evidence — *"I graduated with a degree in Business Administration"* — sits in
the 5th of 6 user turns of a 1 562-character session, i.e. past the 400-character summary
window, and `degree` occurs exactly once.

**Plain tf×idf ranking actively penalises single-mention facts.** Scoring the same session's
terms by `tf × idf` puts `degree` at rank **23** of the keyword candidates: every term said twice
outranks a distinctive term said once, and only 12 keywords fit. The fix is standard IR practice
rather than benchmark tuning — saturate the term frequency (`idf × tf/(tf + k1)`, BM25-style) and
pick the summary with an extractive scorer instead of truncating the opening. With both applied,
the same session yields the keywords `administration, advice, apps, business, creating,
definitely, degree, expenses, getting, graduated, helped, job` and the question retrieves
correctly.

To be precise about *why* saturation helps: it does **not** make any single-mention term beat any
repeated one. It caps the multiplier repetition can earn at `k1 + 1 = 2.2`, so among low-frequency
terms IDF decides instead of raw counts. That is enough here — `degree` at tf 1 with idf 3.58
(3.58) overtakes terms at tf 2–3 with mid IDF (3.1–3.4) — and it is exactly the regime a memory
index lives in, where most evidence is mentioned once. The two behaviours are pinned by unit
tests (`test/harness.test.mjs`) so the claim cannot rot.

This is the same conclusion LongMemEval's own paper draws at a larger scale: what a system
*commits to memory* (`mem_write`'s title/summary/keywords) dominates what retrieval can later
find. A gitmemo operator's lever is the memory-writing policy, not the grep.

**Also fixed while running** (adapter defects, not engine defects):

- Filler sessions imported from ShareGPT/UltraChat can hold **assistant turns only**. The
  user-only retrieval text is then empty, and `mem_write` rejects an empty summary. The
  metadata falls back to the full transcript; the official corpus item is left untouched.
- LongMemEval's scraped transcripts contain **control bytes**, which the engine correctly
  rejects in title, summary *and* content. Cleaning input is the adapter's job (OmniMemEval has
  `sanitize_lme_message_content` for the same reason); `sanitizeForEngine` strips exactly the
  range the engine rejects, keeping tab/LF/CR.
- A fixed temporary work directory let **two concurrent runs delete each other's in-flight
  `.mem` repos** (they share question ids). The work root is now unique per run.
- Occasional `unable to create temporary file` / ENOTEMPTY under many parallel `git` processes
  is a temp-volume flake, not an engine fault (verified: 8 000 parallel writes in the same
  layout reproduce nothing). Instances get a bounded retry and anything that still fails is
  reported in `failMessages`, never silently dropped.

---

## 4. Running the retrieval harness

```bash
# wiring check: 3 instances, prints every step
node evals/longmemeval/run_retrieval.mjs --split oracle --limit 3 --log-every 1

# full oracle split (fast; use as a ceiling/wiring check)
node evals/longmemeval/run_retrieval.mjs --split oracle

# the real benchmark: all 500 instances of _S at session granularity
node --max-old-space-size=8192 evals/longmemeval/run_retrieval.mjs --split s --concurrency 8

# turn granularity (official turn-level metrics are only produced here)
node --max-old-space-size=8192 evals/longmemeval/run_retrieval.mjs --split s --granularity turn

# realistic ingestion: let an LLM write the memories (needs DEEPSEEK_API_KEY)
node evals/longmemeval/run_retrieval.mjs --split s --limit 100 --ingest-keywords llm --query-keywords llm

# ablations
node evals/longmemeval/run_retrieval.mjs --split s --limit 100 --summary prefix --keyword-score tfidf
```

Reference retrievers are always computed on the identical corpus text so a number is
interpretable: `gitmemo` (the system under test), `bm25` (the paper's flat-BM25 analog over
full session text), `oracle` (gold-first, the official ceiling).

Useful flags: `--retrievers gitmemo`, `--topk`, `--page-size`, `--concurrency`, `--offset`,
`--limit`, `--seed N` (deterministic sample), `--out DIR`, `--json`, `--quiet`,
`--keep-workdir`, `--fail-fast`. Do not run two heavy harness runs simultaneously — it is safe
now, but per-instance timings get noisy.

Output: one JSON (all per-instance metrics and top-k rankings, for re-analysis) and one
Markdown report per run under `results/`. The Markdown report also carries upstream's
`print_retrieval_metrics.py` lines verbatim, so a harness number can be diffed directly against
a run of the official scripts.

### Tests

```bash
node --test "evals/longmemeval/test/*.test.mjs"   # 28 hermetic unit tests, no network
```

They are also picked up by the repo's `npm test`. They cover the metric port's edge cases
(including empty gold and the turn→session collapse), the official gold rule, the keyword/summary
strategies, `.mem` entry → context formatting, and both ingest branches with a stubbed client.

### Correctness of the metrics

The metrics are a JavaScript port of upstream's `src/retrieval/eval_utils.py`, including its
edge cases. It was verified by running **both implementations over 200 randomised cases**
(1–40 documents each, gold-poor and gold-heavy, all six k values, both the session-level and the
turn→session collapse path): **7 200 compared values, zero divergence.**

> Upstream's `eval_utils.py` calls `np.asfarray`, **removed in NumPy 2.0**, so the official
> script does not run on a modern NumPy without a shim. The port has no such dependency; the
> cross-check shims it in-memory only.

---

## 5. Results

**`_S`, all 500 instances, session granularity, `idf` ingestion / `plain` queries — 500/500 scored,
zero failures, 507 s.** Commands:

```bash
node --max-old-space-size=8192 evals/longmemeval/run_retrieval.mjs --split oracle --concurrency 6
node --max-old-space-size=8192 evals/longmemeval/run_retrieval.mjs --split s --concurrency 8
```

`_abs` instances excluded, as upstream does; n = 470 non-abstention instances. A full run at
**turn** granularity (48.7 min, ~122 000 memory writes, also 500/500 and zero failures) is in the
granularity section below and is where the gap to BM25 nearly closes.

| Retriever | r_any@5 | r_all@5 | ndcg@5 | r_all@10 | ndcg@10 | r_all@50 |
| --- | --- | --- | --- | --- | --- | --- |
| `gitmemo` | 0.8021 | 0.7362 | 0.6855 | 0.8277 | 0.7090 | **0.9979** |
| `bm25` | 0.8489 | 0.8702 | 0.7862 | 0.9106 | 0.7942 | 1.0000 |
| `oracle` (ceiling) | 0.8915 | 0.9936 | 0.8915 | 1.0000 | 0.8915 | 1.0000 |

By question type (`recall_all@5`, session level):

| Question type | n | `gitmemo` | `bm25` | Note |
| --- | --- | --- | --- | --- |
| temporal-reasoning | 127 | 0.740 | 0.819 | |
| multi-session | 121 | 0.554 | 0.744 | weakest category — needs *several* sessions recalled together |
| knowledge-update | 72 | 0.750 | 0.986 | largest gap to BM25 |
| single-session-user | 64 | 0.859 | 1.000 | |
| single-session-preference | 30 | 0.667 | 0.800 | |
| single-session-assistant | 56 | 1.000 | 1.000 | **degenerate: 51/56 are gold-free** (see §2) |

### What this says

**The ceiling is not the engine's ranking algorithm — it is the retrieval surface.** `gitmemo`
reaches `recall_all@50 = 0.998`: given 50 slots it surfaces essentially every gold session. Its
`ndcg@5 = 0.686` and `recall_all@5 = 0.736` are where it loses to a plain BM25 over full session
text (0.786 / 0.870). So the failure mode is **ranking precision, not coverage**: a fixed-string
OR grep scores by number of matched keywords plus a mild recency bonus, which cannot tell a
distinctive term from a common one, and it competes against an index that simply has more text
to match.

Restricted to instances that actually have gold, `gitmemo` finds *some* gold session in its top 5
90 % of the time (`recall_any@5 = 0.900`) but *all* of them only 70 % of the time
(`recall_all@5 = 0.704`) — the multi-session and knowledge-update categories are exactly the
cases where several pieces must be retrieved together, and that is where the gap to BM25 is
widest (0.554 vs 0.744; 0.750 vs 0.986).

**Ingestion policy is a first-order variable.** Everything above uses the deterministic `idf`
ingestion — a stand-in for the agent that would really write the memory. The ablations
(`--ingest-keywords llm`, `--summary prefix`, `--keyword-score tfidf`) exist because §3 showed a
prefix summary plus plain tf×idf ranking can retrieve *nothing* for a question whose evidence
sits deep in a session. These numbers should therefore be read as a **lower bound for a
keyword-grep memory**, with the `llm` ingestion policy as the realistic operating point.

### Granularity: turn-level memories suit a keyword store far better

Same data, same engine, same queries, **only the size of the memory unit changed** — one entry per
session vs one entry per user turn. 500/500 instances, zero failures, 48.7 min (≈122 000 writes).

| Run | retrieval unit | `gitmemo` r_all@5 | `bm25` r_all@5 | gap |
| --- | --- | --- | --- | --- |
| `--granularity session` | 1 session (~48/instance) | 0.7362 | 0.8702 | **+0.1340** |
| `--granularity turn` | 1 user turn (~245/instance) | 0.7319 | 0.7596 | **+0.0277** |

(Comparable rows: the session-level block of each run — the turn run's is produced by the
turn→session collapse.)

The gap to a full-text BM25 index nearly disappears, 0.134 → 0.028, even though `gitmemo`'s own
score barely moves. The reason is structural: `mem_write`'s retrieval surface is a title, a
summary and at most 12 keywords, which is a large fraction of one short turn but only a small
fraction of a long session. **The lossy step is the projection, so keep what you project small.**
The cost is real — ~245× more entries, ~50 min instead of ~8 min on `_S` — but it removes most of
the retrieval handicap.

Official turn-level numbers from the same run:

| Retriever | turn r_any@5 | turn r_all@5 | turn r_all@10 | turn ndcg@5 | turn ndcg@10 |
| --- | --- | --- | --- | --- | --- |
| `gitmemo` | 0.7660 | 0.6681 | 0.7426 | 0.5896 | 0.6115 |
| `bm25` | 0.7809 | 0.6936 | 0.7830 | 0.6073 | 0.6324 |
| `oracle` | 0.8915 | 0.9872 | 1.0000 | 0.8915 | 0.8915 |

Per type at turn granularity, `gitmemo` `recall_all@10`: `single-session-assistant` 0.964,
`single-session-user` 0.938, `knowledge-update` 0.903, `temporal-reasoning` 0.709,
`multi-session` 0.562, `single-session-preference` **0.400** — *worse* than the 0.500 it scores at
session granularity. A stated preference is usually spread across a conversation rather than
localised in one turn, so splitting the session discards the context that made it retrievable.
Granularity is a per-question-type tradeoff, not a global win.

### Ablation: the ingestion policy is the dominant variable

Same 40 instances (`--seed 7`), same queries (`plain`), same retriever, **only the memory-writing
strategy changed**. 1 757 chat calls, zero failures.

| `gitmemo` ingestion | r_any@5 | r_all@5 | ndcg@5 | r_all@10 | ndcg@10 | r_all@50 |
| --- | --- | --- | --- | --- | --- | --- |
| `idf` (deterministic heuristic) | 0.8158 | 0.6842 | 0.7000 | 0.8421 | 0.7488 | 1.0000 |
| `llm` (an LLM writes each memory) | **0.9211** | **0.8421** | **0.8213** | **0.9211** | **0.8447** | 1.0000 |
| `bm25` over full session text (reference, unchanged) | 0.9474 | 0.9474 | 0.8974 | 0.9474 | 0.8997 | 1.0000 |

```bash
node evals/longmemeval/run_retrieval.mjs --split s --seed 7 --limit 40 --retrievers gitmemo,bm25
node evals/longmemeval/run_retrieval.mjs --split s --seed 7 --limit 40 --ingest-keywords llm --retrievers gitmemo,bm25
```

Changing **only how the memory is written** lifts `recall_all@5` from 0.684 to 0.842 (+23 %
relative) and `ndcg@5` from 0.700 to 0.821, closing most of the gap to a BM25 index that sees
every word of every session. The engine, the query side, the corpus and the metric are identical
between the two rows. Per category, the gains land where retrieval must gather several pieces:

| Question type | n | `idf` | `llm` |
| --- | --- | --- | --- |
| knowledge-update | 7 | 0.714 | **1.000** |
| single-session-user | 5 | 0.600 | **1.000** |
| multi-session | 8 | 0.625 | **0.875** |
| temporal-reasoning | 15 | 0.667 | 0.667 |
| single-session-preference | 2 | 1.000 | 1.000 |

`temporal-reasoning` is the exception: it does not improve with better keyword selection, which is
consistent with gitmemo's recall having no notion of time — the store records a date in the entry
body and front matter, but the *query* cannot filter or weight by it. That is a concrete,
actionable gap, and it is the one upstream's paper addresses with time-aware query expansion.

**Read the default numbers above as a lower bound**; the `llm` row is the realistic operating
point for an agent that actually composes its memories. The gap between the two rows is the
headline result: for a keyword-grep memory, *what you commit to memory* matters more than the
retrieval algorithm.

### The end-to-end companion number

The retrieval metrics above isolate the memory layer. The end-to-end QA run through
[`../omnimemeval/`](../omnimemeval/README.md) — same benchmark, ingest → search → answer →
LLM-judge — scores **0.7860** over all 500 instances, with `multi-session` weakest (0.6165),
which is the *same* category this harness flags (0.554 `recall_all@5`). Two independent
measurements agreeing is the useful part.

It also shows why both layers are needed: `single-session-assistant` is the *best* end-to-end
category (0.9464) while its session-level retrieval metrics are degenerate (51/56 instances
gold-free). Measuring only retrieval would have written that category off.

### Reproducing the oracle ceiling

`oracle` (gold-first) is a wiring check, not a result: with only 2–6 sessions per instance every
retriever reaches ~0.99. Use it to confirm the harness is wired correctly, then read `_S`.

---

## 6. Layout

```
evals/longmemeval/
├── run_retrieval.mjs     # CLI: per-instance ingest → search → official metrics → report
├── lib/
│   ├── dataset.mjs       # loader + official corpus/gold construction (process_item_flat_index)
│   ├── metrics.mjs       # port of eval_utils.py + print_retrieval_metrics aggregation
│   ├── text.mjs          # tokenisation, IDF, BM25, keyword & summary strategies
│   ├── ingest.mjs        # the gitmemo adapter (real GitMemo engine, one .mem repo per instance)
│   ├── format.mjs        # .mem entry → clean context text
│   ├── llm.mjs           # OpenAI-compatible client, disk-cached, concurrency-limited
│   └── report.mjs        # JSON + Markdown reports
├── test/harness.test.mjs # 28 unit tests (also run by `npm test`)
├── data/                 # datasets (git-ignored)
└── results/              # run outputs (git-ignored)
```

One `.mem` repository per *instance* keeps benchmark queries isolated; state is on disk, so a
run is reproducible and inspectable (`git -C <workdir>.mem log --oneline`).

---

## 7. Known limitations

- **The keyword strategies are stand-ins.** `idf`/`plain` approximate an agent's judgement with
  a deterministic heuristic. Treat `idf` numbers as a *lower bound* policy and `llm` as the
  realistic one; the gap between them is itself the finding.
- **Session granularity indexes user turns only**, matching upstream, so an assistant-only
  filler session is an unretrievable corpus item. That is upstream behaviour, preserved.
- **`gitmemo` reuses the engine's own duplicate-digest guard**; a slot marker in the body keeps
  byte-identical sessions inside one instance from colliding. Bodies are never searched, so this
  cannot leak into recall.
- **`_M` is not downloaded** (~2.6 GB). Add it with
  `python data/longmemeval/prepare_longmemeval.py --variant m` inside the OmniMemEval checkout
  if a 500-session variant is ever needed.
