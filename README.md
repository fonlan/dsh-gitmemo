# dsh-gitmemo

**Git-backed long-term memory for DeepSeek Harness (dsh)** — a Cordis plugin mirroring
[GitMemo](https://github.com/fonlan/gitmemo). The agent stores completed task outcomes as
markdown entries in a local **`.mem`** Git repository and searches them before starting new
work. Git is the only dependency, and no manual memory commands are ever needed.

## Key Characteristics

- **Extremely simple** — once installed, no manual memory commands in day-to-day tasks
- **Fully automated** — the agent runs `init`, `search`, `read`, `write`, `delete` as part of its normal task flow
- **Local-only & offline** — memory lives in a local `.mem` Git repository; no cloud dependency
- **Git-only** — no runtime dependency beyond the `git` CLI
- **Token-efficient** — reuses prior conclusions via `mem_search` instead of re-injecting context
- **Prevents context bloat** — search-first workflow; the skill caps reads at 5 relevant memories
- **Auditable** — every memory action is a commit in `.mem`'s Git history
- **Traceable** — each memory can be traced and replayed from commit history
- **Branch-aligned** — the `.mem` branch follows the project's current branch on writes

## What the Plugin Provides

| Piece | Description |
| --- | --- |
| `mem_init` | Initialize the `.mem` repository (all other tools auto-initialize) |
| `mem_search` | Search memories: `keywords` (comma-separated), `skip` (pagination), `mode` (`and` / `or` / `auto` — AND first, OR fallback). Returns up to 20 hits as `hash|title|date` |
| `mem_read` | Read one memory entry by commit hash (full markdown) |
| `mem_write` | Store a task outcome: `title` + `content` (or `content_file` / `file`), optional `body` / `body_file`. Commits `.mem/entries/<timestamp>-<slug>.md` and aligns the `.mem` branch |
| `mem_delete` | Delete a memory entry by commit hash (then redo and rewrite) |
| `gitmemo` skill | Runtime skill with the full workflow rules (search before work, write after completion, delete+rewrite on dissatisfaction, end-of-session checkpoint) |
| System-prompt section | A short pointer so every session knows memory tools exist |

## Installation

Requires dsh ≥ 0.1.0-rc.6 and the `git` CLI.

From the npm registry (once published):

```bash
dsh plugin --profile web add dsh-gitmemo
```

From a local checkout (development / unpublished):

```bash
dsh plugin --profile web add /path/to/dsh-gitmemo
```

Then restart the dsh profile (e.g. restart the `dsh web` process). The plugin registers on the
host plane, so every agent session in that profile sees the tools and the skill.

### Configuration

The bundle patch ships with sensible defaults; override them in the profile's
`cordis.patch.yml`:

```yaml
- id: dsh-gitmemo
  config:
    memDirName: .mem      # memory repo directory name at the project root
    searchLimit: 20       # max hits per mem_search call
    branchAlign: true     # .mem branch follows the project branch on write
    projectRoot: null     # optional explicit project root (defaults to the session cwd)
```

## Memory Location

The `.mem` repository lives at the **project root** of the calling session's workspace
(`git rev-parse --show-toplevel`, falling back to the working directory). Entries are
markdown files under `.mem/entries/`; every operation is a commit, so the whole memory is
readable with plain `git`:

```bash
git -C .mem log --oneline
git -C .mem show <commit-hash>
```

## Agent Workflow (from the bundled skill)

1. **Before work — search.** Extract 3-5 keywords from the request → `mem_search`. If more
   than 5 hits are relevant, read only the 5 most likely (`mem_read`). Paginate with `skip`
   20, 40, … when nothing relevant appears.
2. **After completion — write.** `mem_write` only when the task is **complete**, **repo-related**,
   and the outcome is **valuable/reusable** (or the user explicitly asked to remember). Never
   write for pure Q&A, incomplete tasks, non-repo work, or purely operational git actions.
3. **User unsatisfied — delete and rewrite.** `mem_delete <hash>` → redo from feedback →
   `mem_write` a corrected entry.
4. **End-of-session checkpoint.** When the user says "no more tasks" / "that's all", write any
   pending memories before closing the conversation.

## Entry Format

```markdown
---
date: 2026-02-19T15:10:10Z
status: done
repo_branch: main
repo_commit: 9f3e1a2
mem_branch: main
related_paths: [src/auth/login.ts]
tags: [auth, security]
---
### Original User Request
(verbatim)
### AI Understanding
- Goal: / Constraints: / Out of scope:
### Final Outcome
- Changes/outputs summary
```

## Development

```bash
npm install
npm run build    # tsc → lib/
npm test         # build + engine/plugin unit tests (node:test)
```

## Layout

```
dsh-gitmemo/
├── package.json          # npm package; dsh.bundle.patch wires the profile layer
├── cordis.patch.yml      # composition layer: the dsh-gitmemo row
├── src/
│   ├── index.ts          # Cordis plugin: mem_* tools + gitmemo skill + prompt section
│   └── mem.ts            # core engine (port of gitmemo scripts/mem.sh)
├── assets/gitmemo.md     # bundled skill body
├── lib/                  # built output (committed; used by file:/git installs)
└── test/mem.test.mjs     # engine + plugin unit tests
```

## License

MIT
