# dsh-gitmemo

**基于 Git 的 DeepSeek Harness (dsh) 长期记忆插件** —— 一个镜像
[GitMemo](https://github.com/fonlan/gitmemo) 功能的 Cordis 插件。Agent 会把已完成任务的结论以
markdown 条目存入项目根目录的本地 **`.mem`** Git 仓库，并在开始新任务前先搜索既往记忆。唯一依赖
是 Git，日常使用完全无需手动记忆命令。

## 核心特性

- **极其简单** —— 安装后日常任务无需任何手动记忆命令
- **全自动** —— Agent 在正常任务流程中自动执行 `init` / `search` / `read` / `write` / `delete`
- **纯本地、可离线** —— 记忆存于本地 `.mem` Git 仓库，无云端依赖
- **仅依赖 Git** —— 除 `git` CLI 外无任何运行时依赖
- **省 token** —— 通过 `mem_search` 复用既有结论，而非反复注入上下文
- **防止上下文膨胀** —— 先搜索后工作的流程，技能规定最多只读 5 条最相关记忆
- **可审计** —— 每次记忆操作都是 `.mem` Git 历史中的一次提交
- **可追溯** —— 每条记忆都能从提交历史中回溯与重放
- **分支对齐** —— 写入时 `.mem` 分支跟随项目当前分支

## 插件提供的内容

| 内容 | 说明 |
| --- | --- |
| `mem_init` | 初始化 `.mem` 仓库（其余工具都会自动初始化） |
| `mem_search` | 搜索记忆：`keywords`（逗号分隔）、`skip`（分页）、`mode`（`and` / `or` / `auto`，auto 先 AND 后 OR 兜底）。每次最多返回 20 条 `hash|title|date` |
| `mem_read` | 按提交哈希读取一条记忆的完整 markdown |
| `mem_write` | 存储任务结论：`title` + `content`（或 `content_file` / `file`），可选 `body` / `body_file`。提交为 `.mem/entries/<时间戳>-<slug>.md` 并对齐 `.mem` 分支 |
| `mem_delete` | 按提交哈希删除记忆条目（然后重做并重写） |
| 常驻规则片段 | 完整工作流规则（相当于 gitmemo 的 `agents-template.md`）注入**每个**会话的系统提示词——无需加载技能即可生效 |
| 会话开始注入 | 每个新**根** Agent 会话开始时，自动把最近 N 条记忆标题（`hash|title|date`）注入该系统提示词，跨会话上下文在调用任何工具前即可见；子代理被跳过，且该查询只读、绝不创建 `.mem` |

## 安装

需要 dsh ≥ 0.1.0-rc.6 与 `git` CLI。

从 npm 仓库（发布后）：

```bash
dsh plugin --profile web add dsh-gitmemo
```

从本地源码目录（开发/未发布）：

```bash
dsh plugin --profile web add /path/to/dsh-gitmemo
```

然后重启对应的 dsh profile（例如重启 `dsh web` 进程）。插件注册在宿主平面，该 profile 下所有
Agent 会话都能看到这些工具与技能。

### 配置

bundle patch 自带合理默认值，可在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-gitmemo
  config:
    memDirName: .mem       # 项目根目录下记忆仓库的目录名
    searchLimit: 20        # 每次 mem_search 返回的最大条数
    branchAlign: true      # 写入时 .mem 分支跟随项目分支
    recentContextLimit: 5  # 注入每个新会话系统提示词的最近记忆条数（0 表示关闭）
    projectRoot: null      # 可选：显式项目根目录（默认取会话工作目录）
```

## 记忆存放位置

`.mem` 仓库位于调用会话工作区的**项目根目录**（`git rev-parse --show-toplevel`，找不到时退回
工作目录）。条目是 `.mem/entries/` 下的 markdown 文件；每次操作都是一次提交，整个记忆可以用
普通 `git` 命令查看：

```bash
git -C .mem log --oneline
git -C .mem show <commit-hash>
```

## 记忆如何被强制执行

插件不会把记忆使用完全交给运气：

- **工具** —— `mem_init` / `mem_search` / `mem_read` / `mem_write` / `mem_delete` 注册进每个 Agent 的工具目录。
- **常驻规则** —— 完整工作流规则（见下）是每个会话系统提示词中的固定片段（相当于 gitmemo 的 `agents-template.md`），模型不可能错过；每个 mem_* 工具的描述自带参数契约。
- **会话开始注入** —— 每个新根会话的系统提示词自动包含最近记忆标题（`recentContextLimit` 可配置），跨会话连续性在任何工具调用前即可见。查询只读：绝不创建 `.mem`，子代理被跳过。

仍由模型判断的部分：关键词的选择、是否 `mem_read` 某条命中——与原版 gitmemo 一致。无法挂钩的部分：dsh 没有可靠的"会话结束"事件（`session/disposed` 只在会话被删除时触发），因此会话结束写入由常驻的检查点规则强制执行，与原版技能的做法相同。

> 提示：建议把 `.mem/` 加入项目的 `.gitignore`，避免记忆仓库混入项目提交。

## Agent 工作流（常驻规则）

1. **开工前 —— 搜索。** 从请求中提取 3-5 个关键词 → `mem_search`。若相关结果超过 5 条，只
   `mem_read` 最可能相关的 5 条。无相关结果时用 `skip` 20、40… 翻页。
2. **完成后 —— 写入。** 仅当任务**已完成**、**与当前仓库相关**、且结论**有价值/可复用**（或用户
   明确要求记住）时才 `mem_write`。纯问答、未完成任务、与仓库无关的工作、纯操作性的 git 动作
   一律不写。
3. **用户不满意 —— 删除重写。** `mem_delete <hash>` → 按反馈重做 → `mem_write` 更正后的条目。
4. **会话结束检查点。** 用户说"没有其他任务了"、"就这样"时，关闭会话前必须检查并写入所有待写记忆。

## 条目格式

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

## 开发

```bash
npm install
npm run build    # tsc → lib/
npm test         # 构建 + 引擎/插件单元测试（node:test）
```

## 目录结构

```
dsh-gitmemo/
├── package.json          # npm 包；dsh.bundle.patch 接入 profile 层
├── cordis.patch.yml      # 组合层：dsh-gitmemo 行
├── src/
│   ├── index.ts          # Cordis 插件：mem_* 工具 + gitmemo 技能 + 提示词片段
│   └── mem.ts            # 核心引擎（gitmemo scripts/mem.sh 的移植）
├── lib/                  # 构建产物（已提交，供 file:/git 安装使用）
└── test/mem.test.mjs     # 引擎 + 插件单元测试
```

## License

MIT
