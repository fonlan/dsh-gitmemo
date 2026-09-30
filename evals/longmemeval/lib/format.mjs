/**
 * Turn a raw `.mem` entry file into the text a memory backend hands to the
 * answer LLM.
 *
 * The engine stores YAML front matter plus a generated skeleton:
 *
 *     ---
 *     gitmemo_version: "2"
 *     date: ...
 *     keywords: ...
 *     ---
 *
 *     # <title>
 *
 *     ## Summary
 *     <summary>
 *
 *     ## Final Outcome
 *     <body>
 *
 * The front matter is bookkeeping (format version, branch, digest) and pure
 * noise in a prompt, so it is stripped. The summary is kept only when it adds
 * information the body does not already start with — the deterministic
 * extractive summary is often a near-prefix of the body, and repeating it just
 * burns context.
 */
export function formatMemory(raw, { title, summary } = {}) {
  let text = String(raw ?? "");
  const frontMatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (frontMatter) text = text.slice(frontMatter[0].length);

  const heading = text.match(/^\s*#\s+(.+?)\s*\r?\n/);
  const entryTitle = title ?? heading?.[1] ?? "";

  const summaryMatch = text.match(/\r?\n##\s*Summary\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/);
  const outcomeMatch = text.match(/\r?\n##\s*Final Outcome\s*\r?\n([\s\S]*)$/);
  const body = (outcomeMatch?.[1] ?? text).trim();

  let entrySummary = (summary ?? summaryMatch?.[1] ?? "").trim();
  if (entrySummary) {
    const probe = entrySummary.slice(0, Math.min(120, entrySummary.length));
    const normalizedBody = body.replace(/\s+/g, " ").toLowerCase();
    if (normalizedBody.includes(probe.replace(/\s+/g, " ").toLowerCase())) entrySummary = "";
  }

  const parts = [];
  if (entryTitle) parts.push(`### ${entryTitle}`);
  if (entrySummary) parts.push(entrySummary);
  if (body) parts.push(body);
  return parts.join("\n\n");
}
