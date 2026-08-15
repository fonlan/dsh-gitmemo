# GitMemo — AI Agent Long-Term Memory (dsh-gitmemo)

This deployment uses the gitmemo plugin: long-term memory stored in a local **`.mem`** Git repository next to the project root. Git is the only dependency, and no manual memory commands are ever needed. The workflow rules below are ALWAYS present in the system prompt; this skill is the complete reference for the tool argument contract and entry format.

## Tools

The memory interface is exposed as dedicated tools (do NOT shell out to `git` or poke at `.mem` directly):

- `mem_search <keywords> [skip] [mode]` — search past memories. `keywords` is a comma-separated list. `mode` is `and` (strict), `or` (broad), or `auto` (try AND first, fall back to OR; default). Returns up to 20 results per call as `hash|title|date` entries.
- `mem_read <commit_hash>` — read one memory entry's full markdown. Accepts only a commit hash, no other flags.
- `mem_write` — store a completed task outcome:
  - `title`: short `[module] action + object` title (required)
  - `content`: the memory entry markdown (required unless `content_file`/`file` is given)
  - `content_file`: path to a markdown file with the entry (alternative to `content`)
  - `file`: an existing `.mem/entries/...` path to commit in place
  - `body` / `body_file`: optional 1-3 sentence commit body
  - The entry is committed to `.mem/entries/<YYYYMMDDTHHMMSSZ>-<slug>.md` and the `.mem` branch is aligned to the current project branch.
- `mem_delete <commit_hash>` — remove a memory entry (then redo the work and `mem_write` a corrected one).
- `mem_init` — initialize the `.mem` repository (all other tools auto-initialize, so this is rarely needed).

## Entry Format

Write entries as markdown with YAML front matter:

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

## Workflow

1. **Before work — search.** Extract 3-5 keywords from the user request and run `mem_search`. If more than 5 results are relevant, select only the 5 most likely (keyword overlap, title specificity, recency) before `mem_read`. If nothing relevant, paginate with `skip` 20, 40, ... If relevant memories exist, reuse their conclusions when appropriate.
2. **After completion — write.** Write a memory only when ALL of these hold: the task is complete, the task is related to the current repository, AND the outcome is valuable and reusable OR the user explicitly asked to remember it. If the user explicitly asked to remember, that overrides the value requirement, but completion and repo relevance still apply. Never write for incomplete tasks, pure Q&A, non-repo work, or purely operational git actions (commit/push only).
3. **User unsatisfied — delete and rewrite.** Run `mem_delete <commit_hash>`, redo the task from feedback, then `mem_write` a corrected entry.
4. **End-of-session checkpoint.** When the user says "no more tasks", "that's all", or the conversation is ending, check whether any completed task still needs a memory written, and write all pending memories before closing the conversation.
