import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  ALLOWED_CLI_MODE_NAMES,
  ALLOWED_CORE_EVENT_KINDS,
  REMOVED_DONOR_PATHS,
  inspectTnanoSurface,
} from "./tnano-surface-budget.ts";

const fixtureRoots: Array<string> = [];

NodeTest.afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tnano-surface-budget-"));
  fixtureRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, contents: string): void {
  const filePath = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, contents);
}

function writePackage(
  root: string,
  relativeRoot: string,
  manifest: Record<string, unknown>,
  sources: Readonly<Record<string, string>> = {},
): void {
  writeFile(
    root,
    NodePath.join(relativeRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const [relativePath, source] of Object.entries(sources)) {
    writeFile(root, NodePath.join(relativeRoot, relativePath), source);
  }
}

function pinnedSources(): {
  readonly app: string;
  readonly sdk: string;
} {
  return {
    app: `export const CLI_MODE_NAMES = ${JSON.stringify(ALLOWED_CLI_MODE_NAMES)} as const;\n`,
    sdk: `export const CORE_EVENT_KINDS = ${JSON.stringify(ALLOWED_CORE_EVENT_KINDS)} as const;\n`,
  };
}

function writeHealthyClosure(root: string): void {
  const sources = pinnedSources();
  writePackage(
    root,
    "apps/tnano",
    {
      name: "t-nano",
      type: "module",
      dependencies: { "@t-nano/sdk": "workspace:*" },
    },
    {
      "src/index.ts": `import { CORE_EVENT_KINDS } from "@t-nano/sdk";\n${sources.app}void CORE_EVENT_KINDS;\n`,
    },
  );
  writePackage(
    root,
    "packages/sdk",
    { name: "@t-nano/sdk", type: "module" },
    { "src/events.ts": `import * as Fs from "node:fs";\n${sources.sdk}void Fs.constants;\n` },
  );
}

NodeTest.test("accepts the isolated T-Nano workspace dependency closure", () => {
  const root = fixtureRoot();
  writeHealthyClosure(root);

  const report = inspectTnanoSurface(root);

  NodeAssert.deepEqual(report.violations, []);
  NodeAssert.deepEqual(report.warnings, []);
  NodeAssert.deepEqual(report.packages, ["@t-nano/sdk", "t-nano"]);
  NodeAssert.equal(report.sourceFilesScanned, 2);
});

NodeTest.test("rejects physically restored donor product domains", () => {
  const root = fixtureRoot();
  writeHealthyClosure(root);
  writeFile(root, "apps/web/package.json", '{"name":"@t3tools/web"}\n');
  writeFile(root, "packages/shared/src/index.ts", "export const donor = true;\n");

  const report = inspectTnanoSurface(root);
  const restored = report.violations
    .filter((violation) => violation.code === "donor-domain-present")
    .map((violation) => NodePath.relative(root, violation.path));

  NodeAssert.deepEqual(restored, ["apps/web", "packages/shared"]);
  NodeAssert.ok(REMOVED_DONOR_PATHS.includes("apps/web"));
  NodeAssert.ok(REMOVED_DONOR_PATHS.includes("packages/shared"));
});

NodeTest.test("rejects a direct @t3tools dependency", () => {
  const root = fixtureRoot();
  const sources = pinnedSources();
  writePackage(
    root,
    "apps/tnano",
    {
      name: "t-nano",
      dependencies: { "@t3tools/contracts": "workspace:*" },
    },
    { "src/index.ts": `${sources.app}${sources.sdk}` },
  );

  const report = inspectTnanoSurface(root);

  NodeAssert.ok(
    report.violations.some(
      (violation) =>
        violation.code === "donor-dependency" && violation.specifier === "@t3tools/contracts",
    ),
  );
});

NodeTest.test("finds a forbidden dependency through transitive T-Nano workspaces", () => {
  const root = fixtureRoot();
  const sources = pinnedSources();
  writePackage(
    root,
    "apps/tnano",
    { name: "t-nano", dependencies: { "@t-nano/sdk": "workspace:*" } },
    { "src/modes.ts": sources.app },
  );
  writePackage(
    root,
    "packages/sdk",
    { name: "@t-nano/sdk", dependencies: { "@t-nano/core": "workspace:*" } },
    { "src/events.ts": sources.sdk },
  );
  writePackage(
    root,
    "packages/core",
    { name: "@t-nano/core", dependencies: { react: "19.0.0" } },
    { "src/index.ts": "export const core = true;\n" },
  );

  const report = inspectTnanoSurface(root);

  NodeAssert.deepEqual(report.packages, ["@t-nano/core", "@t-nano/sdk", "t-nano"]);
  NodeAssert.ok(
    report.violations.some(
      (violation) =>
        violation.code === "forbidden-dependency" &&
        violation.packageName === "@t-nano/core" &&
        violation.specifier === "react",
    ),
  );
});

NodeTest.test("rejects relative imports that escape a T-Nano package", () => {
  const root = fixtureRoot();
  const sources = pinnedSources();
  writePackage(
    root,
    "apps/tnano",
    { name: "t-nano", dependencies: { "@t-nano/sdk": "workspace:*" } },
    { "src/modes.ts": sources.app },
  );
  writePackage(
    root,
    "packages/sdk",
    { name: "@t-nano/sdk" },
    { "src/index.ts": `import "../../shared/src/path.ts";\n${sources.sdk}` },
  );
  writePackage(root, "packages/shared", { name: "@t3tools/shared" }, { "src/path.ts": "" });

  const report = inspectTnanoSurface(root);

  NodeAssert.ok(
    report.violations.some(
      (violation) =>
        violation.code === "relative-import-escape" &&
        violation.specifier === "../../shared/src/path.ts",
    ),
  );
  NodeAssert.ok(
    report.violations.some(
      (violation) =>
        violation.code === "donor-source-import" &&
        violation.specifier === "../../shared/src/path.ts",
    ),
  );
});

NodeTest.test("inspects literal dynamic imports", () => {
  const root = fixtureRoot();
  const sources = pinnedSources();
  writePackage(
    root,
    "apps/tnano",
    { name: "t-nano", dependencies: { "@t-nano/sdk": "workspace:*" } },
    { "src/modes.ts": sources.app },
  );
  writePackage(
    root,
    "packages/sdk",
    { name: "@t-nano/sdk" },
    { "src/index.ts": `${sources.sdk}export const load = () => import("playwright");\n` },
  );

  const report = inspectTnanoSurface(root);

  NodeAssert.ok(
    report.violations.some(
      (violation) => violation.code === "forbidden-import" && violation.specifier === "playwright",
    ),
  );
});

NodeTest.test("pins exported core event kinds and CLI mode names", () => {
  const root = fixtureRoot();
  writePackage(
    root,
    "apps/tnano",
    { name: "t-nano", dependencies: { "@t-nano/sdk": "workspace:*" } },
    { "src/modes.ts": 'export const CLI_MODES = ["interactive", "print", "rpc"] as const;\n' },
  );
  writePackage(
    root,
    "packages/sdk",
    { name: "@t-nano/sdk" },
    {
      "src/events.ts": `export const CORE_EVENT_KINDS = ${JSON.stringify([...ALLOWED_CORE_EVENT_KINDS, "usage.snapshot"])} as const;\n`,
    },
  );

  const report = inspectTnanoSurface(root);

  NodeAssert.ok(
    report.violations.some((violation) => violation.code === "core-event-kinds-mismatch"),
  );
  NodeAssert.ok(
    report.violations.some((violation) => violation.code === "cli-mode-names-mismatch"),
  );
});

NodeTest.test("reports missing early-development packages without throwing or failing", () => {
  const root = fixtureRoot();

  const report = inspectTnanoSurface(root);

  NodeAssert.deepEqual(report.violations, []);
  NodeAssert.equal(report.packages.length, 0);
  NodeAssert.match(report.warnings.join("\n"), /entry package is not present/u);
});
