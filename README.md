# dsh-gitmemo

**English** | [**简体中文**](README.zh.md)

**Git-backed long-term memory for DeepSeek Harness (dsh)** — a Cordis plugin mirroring
[GitMemo](https://github.com/fonlan/gitmemo). The root agent stores completed task outcomes as
**immutable** markdown entries in a local **`.mem`** Git repository (a single `main` branch with
structured commit messages) and searches them before starting new work. Git is the only
dependency, and no manual memory commands are ever needed.

## Key Characteristics

- **Extremely simple** — once installed, no manual memory commands in day-to-day tasks
- **Fully automated** — the root agent runs `search`, `read`, `write`, `delete`, `replace` as part of its normal task flow
- **Local-only & offline** — memory lives in a local `.mem` Git repository; no cloud dependency
- **Git-only** — no runtime dependency beyond the `git` CLI
- **Token-efficient** — reuses prior conclusions via `mem_search`; subagents carry neither the workflow rules nor the tool schemas
- **Immutable entries** — every write creates a new file; corrections use `mem_replace` (one commit deletes the old file and adds the new one), withdrawal uses `mem_delete`
- **Knowledge freshness** — `mem_replace` is not just for user corrections: work that overrules a stored conclusion actively replaces it; `mem_search` scores hits as distinct matched keywords + a mild recency bonus (≤ +0.5, linearly decaying to 0 over ~180 days), so conflicting stale conclusions lose to their replacements
- **Topic pages (MOC)** — a `kind: "topic"` entry aggregates a topic's "current truth": the summary states the currently-valid conclusions and the page evolves via `mem_replace` (kind is inherited), not per-task rewrites
- **Wiki links between entries** — content references other entries as `[[<commit-hash>]]`; `mem_read` with `expand: true` resolves those links one hop and automatically follows the `GitMemo-Replaces` chain to a replaced target's active version (dangling links come back with an error)
- **Structured search** — commit messages carry `GitMemo-*` trailers (keywords, digest, search-text projections); search is `git log --grep --fixed-strings` over commit messages only — entry bodies are never scanned
- **Auditable** — every memory action is a commit in `.mem`'s Git history; replaced/deleted entries stay readable by hash
- **Crash-safe** — write/delete/replace run under a cross-process lock with a journal written before entry mutation; migration uses a sibling swap journal so an interrupted directory exchange is recovered before automatic initialization
- **Single-branch** — `.mem` permanently stays on `main`; the code branch/SHA is recorded as entry metadata only

## What the Plugin Provides

| Piece | Description |
| --- | --- |
| `mem_search` | Search memories: `keywords` (array of 1–15, 中英文同义词), `skip` + `snapshot` (stable pagination). Returns up to 20 scored hits with `summary` / `keywords` / `kind` / `matched_keywords` (score = matched keywords + recency bonus) |
| `mem_read` | Read one memory entry by create/replace commit hash (full markdown; historical hashes stay readable); returns `kind`; optional `expand: true` resolves `[[hash]]` links one hop |
| `mem_write` | Store a task outcome: `title` + `summary` + `keywords` (2–12) + `content` (engine generates front matter), optional `kind` (`"task"` default / `"topic"` aggregated page), `related_branches` / `related_paths`. One ADD commit per immutable file |
| `mem_delete` | Withdraw an obsolete conclusion (requires `commit_hash` + `reason`) |
| `mem_replace` | Correct an outdated conclusion in ONE atomic commit (D old + A new) — never delete-then-write. Triggered by user corrections AND by work that overrules a stored conclusion; `kind` defaults to the replaced entry's kind |
| Scoped rules | The workflow rules + the five tools are registered into **root agents only** (`delegationDepth === 0`) at `agent/created`; subagents carry neither |

## Installation

Requires dsh ≥ 0.1.0-rc.6 and the `git` CLI.

From the npm registry (once published):

```bash
dsh plugin --profile web add @fonlan/dsh-gitmemo
```

From a local checkout (development / unpublished):

```bash
dsh plugin --profile web add /path/to/dsh-gitmemo
```

Then restart the dsh profile (e.g. restart the `dsh web` process). The plugin registers on the
host plane, so every new **root** agent session in that profile sees the tools and the rules.

### Configuration

The bundle patch ships with sensible defaults; override them in the profile's
`cordis.patch.yml`:

```yaml
- id: dsh-gitmemo
  config:
    searchLimit: 20        # max hits per mem_search call (page size)
    lockTimeoutMs: 30000   # cross-process lock wait timeout
    projectRoot: null      # optional explicit project root (defaults to the session cwd)
    systemOne:             # optional System-one recall gate, see below
      enabled: true
      endpoint: https://api.typesafe.ai/v1/systemone
      model: jev-latest
      mode: noul           # noul | score
      threshold: 0.5       # noul mode: keep a candidate when P(yes) >= this
```

## System-one Recall Gate (optional)

A `mem_search` page can be handed to a **System-one model** (TypeSafe Jev by
default) for one fast judgement, so memories that are **completely unrelated**
to the current task are dropped before they are injected. Only genuinely
reusable entries survive.

- **Inert by default.** The gate runs only when a usable credential is
  configured (`apiKey`, the credential named by `apiKeyEnv`, or the environment
  variable). With nothing configured, recall behaves **byte-for-byte** as it did
  before the gate existed.
- **Fails open.** A timeout, a non-2xx response, an unparseable body — any
  failure keeps every candidate and reports why in `gated.degraded` +
  `gated.reason`. **A broken endpoint can never hide a memory.**
- **Never empties a page.** If the model rejects the whole page, at least
  `minKeep` (default 1) best-ranked candidates are retained, so "the gate removed
  it" and "there was nothing there" stay distinguishable. The tool's `gated` line
  says so out loud — such a page carries a `NOTE(no candidate scored above the
  threshold…)` marker, so a retained floor is never mistaken for a candidate that
  genuinely passed. `judged=` counts only the candidates actually sent to the
  endpoint, with anything past `maxCandidates` reported as `untouched=`
  (unjudged candidates are never dropped).
- **Recoverable.** `gated.dropped_hashes` lists 8-char hashes of dropped
  entries; `mem_read <short-hash>` brings one back at any time.
- **Auditable.** Every candidate's probability/score and keep/drop verdict goes
  to the plugin log (off the model context), and the endpoint's reported
  `usage.input_tokens` lands in `gated.input_tokens`, so the gate's own cost is
  directly measurable.

### Settings

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; still a no-op without a credential |
| `endpoint` | `https://api.typesafe.ai/v1/systemone` | Any endpoint speaking the same request/answer contract (self-hosted, LiteLLM pass-through, …) |
| `model` | `jev-latest` | Model identifier sent in the request body |
| `apiKey` | — | Declared `role("secret")`: redacted on read, write-only in the form |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | Credential reference; resolved literal key → credentials service → environment |
| `mode` | `noul` | `noul` (yes/no probability) or `score` (graded levels) |
| `threshold` | `0.5` | `noul` mode: keep when P(yes) ≥ this |
| `scoreMin` | `2` | `score` mode cutoff. Note Jev's `score` is `Σ(level_index × probability)`, ranging 0…levels−1 (5 levels → 0…4), **not 0–1** |
| `minKeep` | `1` | Candidates retained when the whole page is rejected |
| `maxCandidates` | `20` | Candidates judged per request; the remainder is **never judged and never dropped** |
| `maxTaskChars` | `2000` | Task-text truncation length |
| `timeoutMs` | `8000` | Request deadline |

Every field is marked `.volatile()` — that is the precondition for the DSH
settings plane to see the entry and apply edits live.

### Settings page

The plugin ships a settings card (**Settings → GitMemo**) where the gate can be
switched on and off and the endpoint, model and API key can be filled in
directly, applying immediately with no restart. The API key is written through
the credentials domain — it is **never persisted as a plaintext config value** —
and the form is write-only. The switch stages `systemOne.enabled`; turning it off
leaves recall byte-for-byte as it was before the gate existed, and a **Save** is
what writes it (the switch alone is a draft). An absent `enabled` reads as on, so
an unconfigured section shows the gate as enabled — which is what the host
default does.

### Known trade-offs

- **English-first.** Jev's primary training language is English; CJK works but
  the vendor documents lower accuracy. The gate's question wording is English;
  only the candidate text and task text may be Chinese.
- **Context ceiling.** 64k tokens per request, of which `state` + the longest
  single question may use 32k. `maxCandidates` and `maxTaskChars` exist to hold
  that line.
- **Latency on the critical path.** Recall runs before every repo task, and the
  gate adds one network round trip (~0.4s observed), so `timeoutMs` defaults to
  8s and every failure path fails open.
- **Data egress.** Memory summaries leave the machine. TypeSafe currently offers
  **no** zero data retention; point `endpoint` at a self-hosted implementation
  (e.g. MIT-licensed `jeff`) or a local endpoint to avoid egress entirely.
- **Billing.** Priced per input token ($0.042 per million input tokens, output
  free) — not per call.

## Memory Location & Format

The `.mem` repository lives at the **project root** of the calling session's workspace
(`git rev-parse --show-toplevel`, falling back to the working directory; an explicit
`projectRoot` config wins). The repo layout:

```text
.mem/
├── .git/
├── .gitmemo-format        # schema version marker, e.g. "2"
└── entries/               # one immutable file per active memory
    └── <utc-ms>-<digest-prefix>-<slug>.md
```

- `.mem` is initialized on its own `main` branch; initialization writes `.mem/` and the lock
  file path into the parent repo's `.git/info/exclude` (never into a version-controlled
  `.gitignore`), and refuses to run when the parent repo already tracks `.mem` content.
- Every write creates a brand-new file with an exclusive create (never overwrites), commits
  one ADD commit with structured trailers, and records the code branch/SHA/related paths in
  the entry front matter. Front matter always carries `kind` (`"task"` or `"topic"`); topic
  entries additionally carry a `GitMemo-Kind: topic` commit trailer.

The whole memory stays readable with plain `git`:

```bash
git -C .mem log --oneline
git -C .mem show <commit-hash>
```

## Agent Workflow (always-on rules, root agents)

1. **Before work — search.** For repo-related tasks, extract 1–15 中英文关键词 → `mem_search`.
   Pure chat and general Q&A need no search.
2. **Preselect results.** Based on `title` / `summary` / `keywords` / `score` /
   `matched_keywords`, `mem_read` at most 5 most relevant memories (`kind: "topic"` entries
   are a topic's aggregated entry point — prefer them); paginate with `skip` +
   the returned `snapshot`.
3. **End-of-session checkpoint — the only write path.** When the conversation is ending,
   `mem_write` every completed repo-related task that still lacks a memory and whose outcome is
   **valuable/reusable** (or was explicitly asked to be remembered). Never duplicate an
   already-written entry. Never write for pure Q&A, incomplete tasks, non-repo work, or purely
   operational git actions. `keywords` should be task-related words NOT already present in
   `title` / `summary` (中英文同义词 both fine) — words already there are searchable via
   `title` / `summary` themselves, so repeating them does not improve recall.
4. **Keep fresh.** If the user corrects a stored conclusion and a replacement exists →
   `mem_replace` (never delete-then-write). If it is obsolete with no replacement →
   `mem_delete` with a `reason`. The same applies — without waiting for the user — when this
   session's own work overrules a stored conclusion (implemented/refactored away). When search
   returns conflicting old/new conclusions, trust the newer one (score already includes the
   recency bonus).
5. **Topic pages.** Once a topic has accumulated several memories — or needs a "current truth"
   entry point — write one `kind: "topic"` aggregated entry: the summary states the currently
   valid conclusions, and the content links the evidence entries as `[[<commit-hash>]]` with a
   one-line status each; evolve topic pages via `mem_replace`.
6. **Subagent results.** Only the root agent decides whether a session-level memory is written.

## Development

```bash
npm install
npm run build    # tsc → lib/
npm test         # build + engine/plugin/migration unit tests (node:test)
```

## Layout

```
dsh-gitmemo/
├── package.json          # npm package; dsh.bundle.patch wires the profile layer; bin: dsh-gitmemo
├── cordis.patch.yml      # composition layer: the dsh-gitmemo row
├── src/
│   ├── index.ts          # Cordis plugin: root-agent-scoped mem_* tools + workflow section
│   ├── mem.ts            # core engine (protocol, lock/journal, search, write/read/delete/replace)
│   ├── migrate.ts        # legacy migration (dry-run/apply, backup refs, CAS swap)
│   └── cli.ts            # `dsh-gitmemo migrate` CLI entry
├── lib/                  # built output (committed; used by file:/git installs)
└── test/mem.test.mjs     # engine + plugin + migration unit tests
```

## License

MIT
