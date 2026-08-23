#!/usr/bin/env node
/**
 * dsh-gitmemo CLI — explicit legacy migration (plan 10).
 *
 *   dsh-gitmemo migrate --project-root <path> [--dry-run|--apply]
 *     [--source <legacy-mem-dir>] [--out <baseline-file>] [--baseline <file>]
 *
 * Migration is AUTOMATIC inside the engine (the first operation on a legacy
 * `.mem` repo migrates it in place). This CLI remains for explicit control:
 * non-default --source directories, baseline review, and repos where
 * automatic migration is blocked (conflicts, dirty worktree, ...).
 *
 * Dry-run scans the legacy `.mem` repo without touching any ref/index/work
 * tree state and prints the plan (dedupe, conflicts, estimated commits).
 * `--apply` re-verifies the baseline refs, then migrates inside the
 * cross-process lock; the original `.mem` is only replaced after the new
 * canonical main is fully built and verified.
 *
 * @module dsh-gitmemo/cli
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GitMemoError } from "./mem.js";
import { migrateApply, migrateDryRun } from "./migrate.js";
function usage() {
    return [
        "usage: dsh-gitmemo migrate --project-root <path> [--dry-run|--apply]",
        "       [--source <legacy-mem-dir>] [--out <baseline-file>] [--baseline <file>]",
        "",
        "  --project-root <path>  code project root (the .mem sibling lives here)",
        "  --dry-run              scan the legacy repo and print the migration plan (default)",
        "  --apply                execute migration (uses --baseline, or performs a fresh dry-run first)",
        "  --source <dir>         legacy memory dir (default <projectRoot>/.mem)",
        "  --out <file>           write the dry-run baseline JSON to a file",
        "  --baseline <file>      baseline JSON produced by a previous --dry-run",
        "  --help, -h             show this help"
    ].join("\n");
}
function parseArgs(argv) {
    const args = { projectRoot: "", action: "dry-run" };
    // optional subcommand token: `dsh-gitmemo migrate --project-root ...`
    if (argv[0] === "migrate")
        argv = argv.slice(1);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--project-root":
            case "--projectRoot": {
                const value = argv[i + 1];
                if (value === undefined)
                    throw new GitMemoError("gitmemo: --project-root requires a path");
                args.projectRoot = value;
                i += 1;
                break;
            }
            case "--dry-run":
                args.action = "dry-run";
                break;
            case "--apply":
                args.action = "apply";
                break;
            case "--source":
            case "--sourceDir": {
                const value = argv[i + 1];
                if (value === undefined)
                    throw new GitMemoError("gitmemo: --source requires a path");
                args.source = value;
                i += 1;
                break;
            }
            case "--out": {
                const value = argv[i + 1];
                if (value === undefined)
                    throw new GitMemoError("gitmemo: --out requires a file path");
                args.out = value;
                i += 1;
                break;
            }
            case "--baseline": {
                const value = argv[i + 1];
                if (value === undefined)
                    throw new GitMemoError("gitmemo: --baseline requires a file path");
                args.baseline = value;
                i += 1;
                break;
            }
            case "--help":
            case "-h":
                console.log(usage());
                process.exit(0);
                break;
            default:
                throw new GitMemoError("gitmemo: unknown argument: " + arg + "\n" + usage());
        }
    }
    if (args.projectRoot.length === 0) {
        throw new GitMemoError("gitmemo: --project-root is required\n" + usage());
    }
    return args;
}
function printDryRun(root, report) {
    if (report.alreadyNewFormat === true) {
        console.log(`gitmemo: ${report.baseline.memDir} is already in new format — nothing to migrate.`);
        return;
    }
    const lines = [
        `gitmemo migration dry-run for ${root}`,
        `  source:                ${report.baseline.memDir}`,
        `  legacy branches:       ${report.branches.join(", ") || "(none)"}`,
        `  active legacy entries: ${report.oldEntryCount}`,
        `  unique entries:        ${report.uniqueEntryCount}`,
        `  conflicts:             ${report.conflictCount}`,
        `  estimated main commits: ${report.estimatedMainCommits} (1 init + ${report.uniqueEntryCount} entries)`
    ];
    if (report.conflictCount > 0) {
        lines.push("  conflict manifest:");
        for (const conflict of report.baseline.conflicts) {
            const variants = conflict.variants.map((v) => `${v.branch}@${v.hash.slice(0, 12)}`).join(", ");
            lines.push(`    ${conflict.path}: [${variants}]`);
        }
        lines.push("  → resolve the conflicts, then re-run --dry-run to produce a clean baseline.");
    }
    for (const warning of report.warnings)
        lines.push("  warning: " + warning);
    lines.push("Next: review and run `dsh-gitmemo migrate --project-root <path> --apply` (or pass a saved --baseline file).");
    console.log(lines.join("\n"));
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const root = resolve(args.projectRoot);
    if (args.action === "dry-run") {
        const report = await migrateDryRun(root, { source: args.source });
        printDryRun(root, report);
        if (args.out !== undefined) {
            await writeFile(args.out, JSON.stringify(report.baseline, null, 2) + "\n", "utf8");
            console.log(`baseline written to ${args.out}`);
        }
        return;
    }
    let baseline;
    if (args.baseline !== undefined) {
        try {
            baseline = JSON.parse(await readFile(args.baseline, "utf8"));
        }
        catch (error) {
            throw new GitMemoError("gitmemo: cannot read baseline file " + args.baseline + ": " + String(error));
        }
    }
    else {
        const report = await migrateDryRun(root, { source: args.source });
        if (report.alreadyNewFormat === true) {
            console.log(`gitmemo: ${report.baseline.memDir} is already in new format — nothing to migrate.`);
            return;
        }
        if (report.conflictCount > 0) {
            printDryRun(root, report);
            throw new GitMemoError("gitmemo: migration has conflicts — resolve them before --apply");
        }
        baseline = report.baseline;
    }
    const report = await migrateApply(root, baseline, { source: args.source });
    if (report.alreadyMigrated === true) {
        console.log(`gitmemo: ${baseline.memDir} is already in new format — nothing to migrate.`);
        return;
    }
    console.log([
        `gitmemo migration applied for ${root}`,
        `  entries reimported: ${report.entries}`,
        `  old branches backed up: ${report.oldBranches.join(", ")}`,
        `  backup refs: ${report.backupRefPrefix}<branch> (kept permanently; old hashes stay readable)`,
        `  new main: ${report.newMain}`
    ].join("\n"));
}
main().catch((error) => {
    const message = error instanceof GitMemoError ? error.message : String(error);
    console.error("gitmemo: " + message);
    process.exit(1);
});
