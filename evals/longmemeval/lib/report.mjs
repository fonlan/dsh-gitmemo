/**
 * Run-record reporting for the LongMemEval harness.
 *
 * The "official lines" reproduce `print_retrieval_metrics.py` verbatim (same
 * metric names, same k values, same abstention filter) so the numbers can be
 * diffed against a run of the upstream scripts. Everything else is added
 * context: extra k values, per-question-type buckets, and the counts that make
 * an average interpretable (e.g. how many instances carry no gold document and
 * therefore score 0 on recall_all / ndcg by construction).
 */
import { K_VALUES, mean } from "./metrics.mjs";

const OFFICIAL_SESSION_KEYS = ["recall_all@5", "ndcg_any@5", "recall_all@10", "ndcg_any@10"];
const OFFICIAL_TURN_KEYS = ["recall_all@5", "ndcg_any@5", "recall_all@10", "ndcg_any@10", "recall_all@50", "ndcg_any@50"];

function fmt(value) {
  return typeof value === "number" ? value.toFixed(4) : "—";
}

/** Upstream `print_retrieval_metrics.py` output, verbatim in shape. */
export function officialLines(summary) {
  const lines = [];
  lines.push("Session-level metrics:");
  const sessionBlock = summary.overall.session ?? {};
  lines.push("\t" + OFFICIAL_SESSION_KEYS.map((k) => `${k} = ${fmt(sessionBlock[k])}`).join(", "));
  lines.push("Turn-level metrics:");
  const turnBlock = summary.overall.turn ?? {};
  lines.push("\t" + OFFICIAL_TURN_KEYS.map((k) => `${k} = ${fmt(turnBlock[k])}`).join(", "));
  return lines.join("\n");
}

function tableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

/** Markdown report for one run. */
export function renderMarkdownReport(run) {
  const { meta, summary, splitStats, perRetrieverElapsed } = run;
  const out = [];
  out.push(`# LongMemEval × gitmemo — ${meta.split} (${meta.granularity} granularity)`);
  out.push("");
  out.push(
    `Generated ${meta.generatedAt} · instances: **${meta.nInstances}** (offset ${meta.offset}, limit ${meta.limit ?? "all"}) · ` +
      `query keywords: \`${meta.queryKeywords}\` · ingest keywords: \`${meta.ingestKeywords}\` · top-k: ${meta.topK} · ` +
      `gitmemo page size: ${meta.pageSize}`
  );
  out.push("");
  if (meta.notes?.length) {
    for (const note of meta.notes) out.push(`> ${note}`);
    out.push("");
  }

  out.push("## Split", "");
  out.push(
    `sessions/instance min·median·max = ${splitStats.sessions_min}·${splitStats.sessions_median}·${splitStats.sessions_max} · ` +
      `user turns ${splitStats.user_turns} · answer turns ${splitStats.answer_turns} · abstention instances ${splitStats.abstention}`
  );
  out.push("");
  out.push(
    `Gold-free instances: **${summary.gold_free_non_abstention}** of ${meta.nInstances - splitStats.abstention} non-abstention ` +
      `(their recall_all / ndcg are 0 by construction, exactly as upstream counts them).`
  );
  out.push("");

  for (const [retriever, block] of Object.entries(summary.perRetriever)) {
    out.push(`## Retriever: ${retriever}`, "");
    const elapsed = perRetrieverElapsed?.[retriever];
    if (elapsed) out.push(`Wall clock: ${(elapsed / 1000).toFixed(1)}s`, "");
    const granularities = ["session", "turn"].filter((g) => Object.keys(block.overall[g] ?? {}).length > 0);
    for (const g of granularities) {
      const cols = [];
      for (const metric of ["recall_any", "recall_all", "ndcg_any"]) {
        for (const k of K_VALUES) cols.push(`${metric}@${k}`);
      }
      out.push(`### ${g}-level`, "");
      out.push(tableRow(["metric", ...K_VALUES.map(String)]));
      out.push(tableRow(["---", ...K_VALUES.map(() => "---")]));
      for (const metric of ["recall_any", "recall_all", "ndcg_any"]) {
        out.push(tableRow([metric, ...K_VALUES.map((k) => fmt(block.overall[g][`${metric}@${k}`]))]));
      }
      out.push("");
    }
    out.push("<details><summary>Per question type</summary>", "");
    out.push(tableRow(["question_type", "n", "gold-free", "recall_all@5 (session)", "recall_all@10 (session)", "ndcg_any@5 (session)", "recall_all@10 (turn)"]));
    out.push(tableRow(["---", "---", "---", "---", "---", "---", "---"]));
    for (const [type, t] of Object.entries(block.types ?? {})) {
      out.push(
        tableRow([
          type,
          String(t.n),
          String(t.gold_free),
          fmt(t.session["recall_all@5"]),
          fmt(t.session["recall_all@10"]),
          fmt(t.session["ndcg_any@5"]),
          fmt(t.turn["recall_all@10"])
        ])
      );
    }
    out.push("", "</details>", "");
  }

  out.push("## Official-format lines", "");
  for (const [retriever, block] of Object.entries(summary.perRetriever)) {
    out.push(`\`${retriever}\`:`, "```text", officialLines(block), "```", "");
  }
  return out.join("\n");
}

/** Compact console summary. */
export function printConsoleSummary(run) {
  const { summary } = run;
  for (const [retriever, block] of Object.entries(summary.perRetriever)) {
    const s = block.overall.session ?? {};
    const t = block.overall.turn ?? {};
    const pick = (obj, key) => (typeof obj[key] === "number" ? obj[key].toFixed(3) : "—");
    console.log(
      `  ${retriever.padEnd(8)} session: recall_all@5=${pick(s, "recall_all@5")} recall_all@10=${pick(s, "recall_all@10")} ` +
        `ndcg@5=${pick(s, "ndcg_any@5")} recall_any@5=${pick(s, "recall_any@5")}` +
        (Object.keys(t).length ? ` | turn: recall_all@10=${pick(t, "recall_all@10")} ndcg@10=${pick(t, "ndcg_any@10")}` : "")
    );
  }
}

/**
 * Extra aggregate the official print does not show: mean over instances with
 * gold only. `records` must already be retriever-scoped — i.e. each row's
 * `metrics` is the granularity-keyed block for ONE retriever (the same shape
 * `aggregate` expects).
 */
export function goldOnlyMeans(records, granularity) {
  const rows = records.filter((r) => !r.question_id.includes("_abs") && r.gold_count > 0);
  const keys = ["recall_all@5", "recall_all@10", "ndcg_any@5", "ndcg_any@10", "recall_any@5", "recall_any@10"];
  return Object.fromEntries(
    keys.map((k) => [
      k,
      +mean(rows.map((r) => r.metrics?.[granularity]?.[k]).filter((v) => typeof v === "number")).toFixed(4)
    ])
  );
}
