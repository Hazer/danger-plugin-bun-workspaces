import "./danger/sdk";

export enum ChangeType {
  Valid = "Valid",
  Violation = "Violation",
}

export interface BunLockChange {
  path: string;
  operation: "created" | "modified" | "edited" | "deleted";
  type: ChangeType;
}

export interface BunLockReport {
  validChanges: Record<string, BunLockChange[]>;
  violations: Record<string, BunLockChange[]>;
}

export interface BunLockPluginOptions {
  violationLevel: "warn" | "error" | "disabled";
}

// Helper: map an array to Promises and await them all
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  return Promise.all(items.map(fn));
}

// Helper: take a record of arrays grouped by op,
// run fn(op, paths) for each in parallel, and await all
async function parallelBatches<O extends string, P>(
  batches: Record<O, P[]>,
  fn: (op: O, paths: P[]) => Promise<void>,
): Promise<void> {
  const tasks = (Object.keys(batches) as O[]).map((op) => fn(op, batches[op]));
  await Promise.all(tasks);
}

// 1) Categorize bun.lock changes fully async
async function categorizeBunLockChanges(paths: {
  created: string[];
  modified: string[];
  edited: string[];
  deleted: string[];
}): Promise<BunLockReport> {
  const report: BunLockReport = { validChanges: {}, violations: {} };

  function add(
    bucket: Record<string, BunLockChange[]>,
    path: string,
    op: BunLockChange["operation"],
    type: ChangeType,
  ) {
    if (!bucket[path]) bucket[path] = [];
    bucket[path].push({ path, operation: op, type });
  }

  // Single handler for each batch
  async function handleBatch(
    op: "created" | "modified" | "edited" | "deleted",
    arr: string[],
  ) {
    for (const p of arr) {
      const isRoot = p === "bun.lock";
      if (op === "deleted") {
        // deleting root => violation; deleting inner => valid
        if (isRoot) {
          add(report.violations, p, op, ChangeType.Violation);
        } else {
          add(report.validChanges, p, op, ChangeType.Valid);
        }
      } else {
        // create/modify/edit: root => valid; inner => violation
        if (isRoot) {
          add(report.validChanges, p, op, ChangeType.Valid);
        } else {
          add(report.violations, p, op, ChangeType.Violation);
        }
      }
    }
  }

  // Fire all 4 ops in parallel
  await parallelBatches(paths, handleBatch);
  return report;
}

// 2) Generate markdown fully async
async function generateMarkdownReport(
  report: BunLockReport,
  pkgJsonList: string[],
  pkgChanged: boolean,
): Promise<string> {
  const validKeys = Object.keys(report.validChanges);
  const violKeys = Object.keys(report.violations);

  const totalBunChanges =
    validKeys.reduce((sum, k) => sum + report.validChanges[k].length, 0) +
    violKeys.reduce((sum, k) => sum + report.violations[k].length, 0);

  // Special case 1
  if (totalBunChanges === 0 && pkgChanged) {
    return `
| ⚠️ | bun.lock | unchanged | Potential Violation: ${pkgJsonList.join(
      ", ",
    )} changed but bun.lock hasn't changed at all. |
`.trim();
  }

  // Special case 2
  if (pkgChanged && violKeys.length === 0 && validKeys.length > 0) {
    return "";
  }

  const header = `
| Status | Path       | Operations         | Reason                                                                 |
|--------|------------|--------------------|------------------------------------------------------------------------|
`.trim();

  // Build a row for one path
  async function buildRow(
    path: string,
    changes: BunLockChange[],
    isViolation: boolean,
  ): Promise<string> {
    const ops = Array.from(new Set(changes.map((c) => c.operation))).join(", ");
    let emoji: string, reason: string;

    if (isViolation) {
      emoji = "🚫";
      if (path === "bun.lock" && ops.includes("deleted")) {
        reason = "Violation: The root bun.lock cannot be deleted.";
      } else {
        reason =
          "Violation: Inner packages cannot have bun.lock files. Ensure you are using the workspace configuration correctly.";
      }
    } else {
      emoji = "✅";
      if (path === "bun.lock") {
        reason =
          ops === "created"
            ? "Congratulations, you have been rescued."
            : "Root bun.lock updated.";
      } else {
        reason = "This is da way. Only root lockfile must exist.";
      }
    }
    return `| ${emoji} | ${path} | ${ops} | ${reason} |`;
  }

  // Build all rows in parallel
  // Kick off both groups without awaiting yet
  const validRowsPromise = parallelMap(validKeys, (p) =>
    buildRow(p, report.validChanges[p], false),
  );
  const violRowsPromise = parallelMap(violKeys, (p) =>
    buildRow(p, report.violations[p], true),
  );

  // Now await them in parallel
  const [validRows, violRows] = await Promise.all([
    validRowsPromise,
    violRowsPromise,
  ]);

  return [header, ...validRows, ...violRows].join("\n");
}

/**
 * Given a JSON-diffed package.json, return a markdown table fragment
 * describing added, removed or changed dependencies under a given key.
 */
function renderDepTable(
  pkgPath: string,
  diff: JSONDiff,
  section: "dependencies" | "devDependencies",
): string | null {
  const bucket = (diff[section] ?? {}) as JSONDiffValue;
  // If nothing really changed here, skip.
  if (
    (!bucket.added || bucket.added.length === 0) &&
    (!bucket.removed || bucket.removed.length === 0) &&
    bucket.before === bucket.after
  ) {
    return null;
  }

  // Build rows: [Dependency, Before, After, ChangeType]
  const rows: string[] = [];
  const beforeObj = (bucket.before as Record<string, any>) || {};
  const afterObj = (bucket.after as Record<string, any>) || {};

  // added deps
  if (bucket.added?.length) {
    for (const dep of bucket.added) {
      rows.push(`| ${dep} | (n/a)         | ${afterObj[dep]} | added    |`);
    }
  }
  // removed deps
  if (bucket.removed?.length) {
    for (const dep of bucket.removed) {
      rows.push(`| ${dep} | ${beforeObj[dep]} | (n/a)           | removed  |`);
    }
  }
  // version bumps / other value-changes
  for (const dep of Object.keys(afterObj)) {
    if (
      beforeObj[dep] != null &&
      afterObj[dep] != null &&
      beforeObj[dep] !== afterObj[dep]
    ) {
      rows.push(`| ${dep} | ${beforeObj[dep]} | ${afterObj[dep]} | changed  |`);
    }
  }

  if (rows.length === 0) {
    return null;
  }

  return `
### ${pkgPath} › ${section}

| Package     | Before         | After          | Change   |
|-------------|----------------|----------------|----------|
${rows.join("\n")}
`.trim();
}

/**
 * The Danger plugin entrypoint.
 */
export const bunLockfilesPlugin = async (options: BunLockPluginOptions) => {
  const bunMatch = danger.git.fileMatch("**/bun.lock");
  const pkgMatch = danger.git.fileMatch("**/package.json");

  const bunPaths = bunMatch.getKeyedPaths();
  const pkgPaths = pkgMatch.getKeyedPaths();

  // 1) Kick off bun.lock categorization/report generation
  const categorizePromise = categorizeBunLockChanges(bunPaths);

  // 2) Gather all changed package.json paths
  const allPkgChanged = [
    ...pkgPaths.created,
    ...pkgPaths.modified,
    ...pkgPaths.edited,
    ...pkgPaths.deleted,
  ];
  const pkgChanged = allPkgChanged.length > 0;

  // 3) In parallel, compute dependency‐diff tables for every changed package.json
  const depTablesPromise = (async () => {
    const tables: string[] = [];
    await Promise.all(
      allPkgChanged.map(async (pkgPath) => {
        const diff = await danger.git.JSONDiffForFile(pkgPath);
        for (const section of ["dependencies", "devDependencies"] as const) {
          const tbl = renderDepTable(pkgPath, diff, section);
          if (tbl) tables.push(tbl);
        }
      }),
    );
    return tables;
  })();

  // 4) Meanwhile, get the bun.lock report + markdown
  const report = await categorizePromise;
  const bunMd = await generateMarkdownReport(report, allPkgChanged, pkgChanged);

  // 5) Wait for our dependency tables
  const depTables = await depTablesPromise;

  // 6) Collate outputs:
  //    - The dependency table (if any)
  //    - The bun.lock report (if any)
  //    - The final action: markdown(), warn(), or fail()

  const hasBunChanges =
    Object.values(report.validChanges).flat().length +
      Object.values(report.violations).flat().length >
    0;

  const headerDeps =
    pkgChanged && depTables.length > 0
      ? "## 📦 Dependency changes detected\n"
      : "";

  const bunHeader =
    bunMd && depTables.length > 0
      ? "\n## 🔒 Bun.lock possible violations\n"
      : "";

  const fullMessage = [
    headerDeps,
    depTables.join("\n\n"),
    bunHeader,
    bunMd.trim(),
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  if (!hasBunChanges && pkgChanged) {
    warn(
      fullMessage +
        "\n\n❗️ You updated dependencies but did not update `bun.lock`. Maybe you need to run `bun install`?",
    );
    return;
  }

  if (Object.keys(report.violations).length > 0) {
    options.violationLevel === "warn" ? warn(fullMessage) : fail(fullMessage);
  } else if (hasBunChanges) {
    markdown(fullMessage);
  }
};
