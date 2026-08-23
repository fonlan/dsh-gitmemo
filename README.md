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
- **Structured search** — commit messages carry `GitMemo-*` trailers (keywords, digest, search-text projections); search is `git log --grep --fixed-strings` over commit messages only — entry bodies are never scanned
- **Auditable** — every memory action is a commit in `.mem`'s Git history; replaced/deleted entries stay readable by hash
- **Crash-safe** — write/delete/replace run under a cross-process lock with a journal written before entry mutation; migration uses a sibling swap journal so an interrupted directory exchange is recovered before automatic initialization
- **Single-branch** — `.mem` permanently stays on `main`; the code branch/SHA is recorded as entry metadata only

## What the Plugin Provides

| Piece | Description |
| --- | --- |
| `mem_search` | Search memories: `keywords` (array of 1–12, 中英文同义词), `skip` + `snapshot` (stable pagination). Returns up to 20 scored hits with `summary` / `keywords` / `matched_keywords` |
| `mem_read` | Read one memory entry by create/replace commit hash (full markdown; historical hashes stay readable) |
| `mem_write` | Store a task outcome: `title` + `summary` + `keywords` (2–12) + `content` (engine generates front matter), optional `related_branches` / `related_paths`. One ADD commit per immutable file |
| `mem_delete` | Withdraw an obsolete conclusion (requires `commit_hash` + `reason`) |
| `mem_replace` | Correct an outdated conclusion in ONE atomic commit (D old + A new) — never delete-then-write |
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
```

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
  the entry front matter.

The whole memory stays readable with plain `git`:

```bash
git -C .mem log --oneline
git -C .mem show <commit-hash>
```

## Agent Workflow (always-on rules, root agents)

1. **Before work — search.** For repo-related tasks, extract 1–12 中英文关键词 → `mem_search`.
   Pure chat and general Q&A need no search.
2. **Preselect results.** Based on `title` / `summary` / `keywords` / `score` /
   `matched_keywords`, `mem_read` at most 5 most relevant memories; paginate with `skip` +
   the returned `snapshot`.
3. **End-of-session checkpoint — the only write path.** When the conversation is ending,
   `mem_write` every completed repo-related task that still lacks a memory and whose outcome is
   **valuable/reusable** (or was explicitly asked to be remembered). Never duplicate an
   already-written entry. Never write for pure Q&A, incomplete tasks, non-repo work, or purely
   operational git actions.
4. **User correction.** If a stored conclusion is outdated and a replacement exists →
   `mem_replace` (never delete-then-write). If it is obsolete with no replacement →
   `mem_delete` with a `reason`.
5. **Subagent results.** Only the root agent decides whether a session-level memory is written.

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
