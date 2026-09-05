# dsh-gitmemo

[**English**](README.md) | **简体中文**

**基于 Git 的 DeepSeek Harness (dsh) 长期记忆插件** —— 一个镜像
[GitMemo](https://github.com/fonlan/gitmemo) 功能的 Cordis 插件。根 Agent 会把已完成任务的结论以
**不可变** markdown 条目存入项目根目录的本地 **`.mem`** Git 仓库（单一 `main` 分支 + 结构化提交信息），
并在开始新任务前先搜索既往记忆。唯一依赖是 Git，日常使用完全无需手动记忆命令。

## 核心特性

- **极其简单** —— 安装后日常任务无需任何手动记忆命令
- **全自动** —— 根 Agent 在正常任务流程中自动执行 `search` / `read` / `write` / `delete` / `replace`
- **纯本地、可离线** —— 记忆存于本地 `.mem` Git 仓库，无云端依赖
- **仅依赖 Git** —— 除 `git` CLI 外无任何运行时依赖
- **省 token** —— 通过 `mem_search` 复用既有结论；子代理既不携带工作流规则也不携带工具 schema
- **条目不可变** —— 每次写入都创建新文件；更正用 `mem_replace`（一个提交同时删除旧文件、新增新文件），作废用 `mem_delete`
- **知识保鲜** —— `mem_replace` 不只用于用户更正：本次工作覆盖旧结论时同样主动替换；`mem_search` 评分为「命中关键词数 + 温和的 recency 加成（≤ +0.5，180 天线性衰减到 0）」，新旧结论冲突时自动偏向新条目
- **主题聚合页（MOC）** —— `kind: "topic"` 条目聚合一个主题的「当前真相」：summary 概括当下有效结论，靠 `mem_replace` 演进（kind 自动继承），不按任务重复新增
- **条目间 Wiki 链接** —— content 里用 `[[<commit-hash>]]` 引用其他条目；`mem_read` 传 `expand: true` 一跳展开链接目标，并自动跟随 `GitMemo-Replaces` 链到被替换条目的最新版本（悬空链接带 error 返回）
- **结构化搜索** —— commit message 携带 `GitMemo-*` trailers（keywords、digest、search-text 投影）；搜索只对 commit message 执行 `git log --grep --fixed-strings`，绝不扫描条目正文
- **可审计** —— 每次记忆操作都是 `.mem` Git 历史中的一次提交；被替换/删除的条目仍可按哈希读取
- **崩溃安全** —— write/delete/replace 在修改条目前先写事务 journal；迁移另用 sibling swap journal，目录交换中断后会在自动初始化前恢复
- **单分支** —— `.mem` 永远停留在 `main`；代码分支/SHA 只作为条目元数据记录

## 插件提供的内容

| 内容 | 说明 |
| --- | --- |
| `mem_search` | 搜索记忆：`keywords`（1–12 个关键词数组，建议中英文同义词）、`skip` + `snapshot`（稳定分页）。每次最多返回 20 条带 `summary` / `keywords` / `kind` / `matched_keywords` 的评分结果（score = 命中关键词数 + recency 加成） |
| `mem_read` | 按创建/替换提交哈希读取一条记忆的完整 markdown（历史哈希仍可读）；返回 `kind`；可选 `expand: true` 一跳展开条目内的 `[[hash]]` 链接 |
| `mem_write` | 存储任务结论：`title` + `summary` + `keywords`（2–12）+ `content`（front matter 由引擎生成），可选 `kind`（`"task"` 缺省 / `"topic"` 聚合页）、`related_branches` / `related_paths`。每个不可变文件对应一个 ADD 提交 |
| `mem_delete` | 作废无替代结论（需要 `commit_hash` + `reason`） |
| `mem_replace` | 一个原子提交内更正旧结论（D 旧文件 + A 新文件）—— 禁止先删后写。触发面不只是用户更正：本次工作覆盖旧结论时同样应主动 replace；`kind` 缺省继承被替换条目 |
| 作用域规则 | 工作流规则与五个工具只在 `agent/created` 时注册进**根 Agent**（`delegationDepth === 0`）；子代理两者皆无 |

## 安装

需要 dsh ≥ 0.1.0-rc.6 与 `git` CLI。

从 npm 仓库（发布后）：

```bash
dsh plugin --profile web add @fonlan/dsh-gitmemo
```

从本地源码目录（开发/未发布）：

```bash
dsh plugin --profile web add /path/to/dsh-gitmemo
```

然后重启对应的 dsh profile（例如重启 `dsh web` 进程）。插件注册在宿主平面，该 profile 下每个新
**根** Agent 会话都能看到这些工具与规则。

### 配置

bundle patch 自带合理默认值，可在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-gitmemo
  config:
    searchLimit: 20        # 每次 mem_search 返回的最大条数（每页大小）
    lockTimeoutMs: 30000   # 跨进程锁等待超时
    projectRoot: null      # 可选：显式项目根目录（默认取会话工作目录）
```

## 记忆存放位置与格式

`.mem` 仓库位于调用会话工作区的**项目根目录**（`git rev-parse --show-toplevel`，找不到时退回
工作目录；显式配置 `projectRoot` 优先）。仓库结构：

```text
.mem/
├── .git/
├── .gitmemo-format        # schema 版本标记，如 "2"
└── entries/               # 每个活跃记忆一个不可变文件
    └── <utc-ms>-<digest-prefix>-<slug>.md
```

- `.mem` 初始化在自己的 `main` 分支上；初始化时把 `.mem/` 与锁文件路径写入父仓库的
  `.git/info/exclude`（绝不写入受版本控制的 `.gitignore`），且当父仓库已跟踪 `.mem` 内容时拒绝初始化。
- 每次写入都用独占创建生成全新文件（绝不覆盖），以带结构化 trailers 的 ADD 提交落库，并把代码
  分支/SHA/相关路径记录在条目 front matter 中。front matter 固定携带 `kind`（`"task"` 或 `"topic"`）；
  topic 条目的 commit message 额外带 `GitMemo-Kind: topic` trailer。

整个记忆可以用普通 `git` 命令查看：

```bash
git -C .mem log --oneline
git -C .mem show <commit-hash>
```

## Agent 工作流（常驻规则，仅根 Agent）

1. **开工前 —— 搜索。** 仓库相关任务开始前提取 1–12 个中英文关键词 → `mem_search`。纯闲聊和通用问答无需搜索。
2. **结果预筛。** 根据 `title` / `summary` / `keywords` / `score` / `matched_keywords` 最多
   `mem_read` 5 条最相关记忆（`kind: "topic"` 的条目是该主题的聚合入口，优先读）；用 `skip` + 返回的
   `snapshot` 翻页。
3. **会话结束检查点 —— 唯一的写入路径。** 对话即将结束时，`mem_write` **每一条**已完成、与仓库
   相关、且结论**有价值/可复用**（或用户明确要求记住）但还没有记忆的任务。绝不重复写已存在的条目。
   纯问答、未完成任务、与仓库无关的工作、纯操作性的 git 动作一律不写。`keywords` 应选用与任务相关但未出现在 `title` / `summary` 中的词（中英文同义词皆可）——`title` / `summary` 已有的词本身就能被检索到，重复它们不会提高召回率。
4. **知识保鲜（KEEP FRESH）。** 用户更正旧结论：有替代用 `mem_replace`（禁止先 delete 再 write），作废无替代用带 `reason` 的 `mem_delete`；本次会话的工作覆盖/推翻某条已存结论时同样主动处理，不必等用户指出。检索结果中新旧冲突时优先采信更新的条目（score 已含 recency 加成）。
5. **主题聚合页（TOPIC PAGE）。** 同一主题积累多条记忆、或需要「当前真相」入口时，写一条 `kind: "topic"` 聚合条目：summary 概括当下有效结论，content 用 `[[<commit-hash>]]` 链接证据条目并各配一句话状态；topic 条目靠 `mem_replace` 演进。
6. **子代理结果。** 是否形成一条会话级记忆，由根 Agent 汇总后决定。

## 开发

```bash
npm install
npm run build    # tsc → lib/
npm test         # 构建 + 引擎/插件/迁移单元测试（node:test）
```

## 目录结构

```
dsh-gitmemo/
├── package.json          # npm 包；dsh.bundle.patch 接入 profile 层；bin: dsh-gitmemo
├── cordis.patch.yml      # 组合层：dsh-gitmemo 行
├── src/
│   ├── index.ts          # Cordis 插件：仅根 Agent 的 mem_* 工具 + 工作流片段
│   ├── mem.ts            # 核心引擎（协议、锁/journal、搜索、write/read/delete/replace）
│   ├── migrate.ts        # 旧格式迁移（dry-run/apply、backup refs、CAS 交换）
│   └── cli.ts            # `dsh-gitmemo migrate` CLI 入口
├── lib/                  # 构建产物（已提交，供 file:/git 安装使用）
└── test/mem.test.mjs     # 引擎 + 插件 + 迁移单元测试
```

## License

MIT
