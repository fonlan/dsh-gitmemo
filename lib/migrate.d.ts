/** One deduplicated entry planned for reimport. */
export interface MigrationPlanEntry {
    title: string;
    summary: string;
    keywords: string[];
    content: string;
    date: string;
    codeBranch: string;
    codeCommit: string;
    relatedBranches: string[];
    relatedPaths: string[];
    digest: string;
    sourceBranch: string;
    sourcePath: string;
}
/** Same entry path with different content across branch tips. */
export interface MigrationConflict {
    path: string;
    variants: Array<{
        branch: string;
        hash: string;
        digest: string;
    }>;
}
/** Serializable baseline produced by dry-run and consumed by apply. */
export interface MigrationBaseline {
    format: "dsh-gitmemo-migration-baseline";
    version: 1;
    root: string;
    memDir: string;
    scannedAt: string;
    tips: Record<string, string>;
    entries: MigrationPlanEntry[];
    conflicts: MigrationConflict[];
    warnings: string[];
}
export interface MigrationDryRunReport {
    legacy: boolean;
    alreadyNewFormat?: boolean;
    branches: string[];
    tips: Record<string, string>;
    oldEntryCount: number;
    uniqueEntryCount: number;
    conflictCount: number;
    estimatedMainCommits: number;
    baseline: MigrationBaseline;
    warnings: string[];
}
export interface MigrationApplyReport {
    migrated: boolean;
    alreadyMigrated?: boolean;
    entries: number;
    newMain: string;
    backupRefPrefix: string;
    oldBranches: string[];
}
export interface MigrationOptions {
    /** Legacy memory dir to migrate from (default `<root>/.mem`). */
    source?: string;
    gitTimeoutMs?: number;
    lockTimeoutMs?: number;
}
/**
 * Scan a legacy `.mem` repo and produce the migration plan. Read-only: no
 * ref, index or worktree state is modified (the lock file is transient).
 */
export declare function migrateDryRun(root: string, options?: MigrationOptions): Promise<MigrationDryRunReport>;
/**
 * Execute a previously dry-run migration (plan 10.4). Verifies the baseline
 * refs are unchanged, blocks on conflicts, creates backup refs, builds the
 * new canonical main in a temp repo, then swaps directories atomically.
 */
export declare function migrateApply(root: string, baseline: MigrationBaseline, options?: MigrationOptions): Promise<MigrationApplyReport>;
