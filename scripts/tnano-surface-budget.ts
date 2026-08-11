#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const ALLOWED_CORE_EVENT_KINDS = [
  "session.state",
  "turn.state",
  "content.delta",
  "activity.upsert",
  "request.opened",
  "request.resolved",
  "binding.updated",
  "error",
  "custom",
] as const;

export const ALLOWED_CLI_MODE_NAMES = ["interactive", "print", "json", "rpc"] as const;

export const REMOVED_DONOR_PATHS = [
  ".env.example",
  "app.json",
  "apps/desktop",
  "apps/marketing",
  "apps/mobile",
  "apps/server",
  "apps/web",
  "assets",
  "experiments",
  "infra",
  "native",
  "oxlint-plugin-t3code",
  "packages/client-runtime",
  "packages/contracts",
  "packages/effect-acp",
  "packages/effect-codex-app-server",
  "packages/shared",
  "packages/ssh",
  "packages/tailscale",
  "patches",
  "t3.json",
] as const;

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
] as const;

const runtimeDependencySections = new Set<string>([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const ignoredDirectories = new Set([
  ".git",
  ".vite-plus",
  "__fixtures__",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "test",
  "tests",
]);
const eventKindConstantNames = new Set([
  "CORE_EVENT_KINDS",
  "EVENT_KINDS",
  "TNANO_CORE_EVENT_KINDS",
  "TNANO_EVENT_KINDS",
  "T_NANO_CORE_EVENT_KINDS",
  "T_NANO_EVENT_KINDS",
]);
const cliModeConstantNames = new Set([
  "CLI_MODE_NAMES",
  "CLI_MODES",
  "TNANO_CLI_MODE_NAMES",
  "TNANO_CLI_MODES",
  "T_NANO_CLI_MODE_NAMES",
  "T_NANO_CLI_MODES",
]);
const forbiddenDomainNames = new Set([
  "clerk",
  "cloud",
  "electron",
  "expo",
  "git",
  "mcp",
  "nodepty",
  "opentelemetry",
  "plan",
  "plans",
  "playwright",
  "posthog",
  "preview",
  "react",
  "relay",
  "review",
  "sql",
  "sqlite",
  "ssh",
  "subagent",
  "subagents",
  "tailscale",
  "telemetry",
  "textgeneration",
  "usage",
  "vcs",
  "web",
]);

type DependencySection = (typeof dependencySections)[number];

interface PackageManifest {
  readonly name?: unknown;
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly devDependencies?: unknown;
}

interface WorkspacePackage {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest?: PackageManifest;
  readonly manifestError?: string;
  readonly name?: string;
}

interface SourceImport {
  readonly specifier: string;
  readonly line: number;
  readonly dynamic: boolean;
}

interface Token {
  readonly kind: "identifier" | "punctuation" | "string";
  readonly value: string;
  readonly line: number;
}

interface ExportedStringArray {
  readonly name: string;
  readonly values: ReadonlyArray<string>;
  readonly line: number;
}

export interface SurfaceBudgetViolation {
  readonly code:
    | "cli-mode-names-mismatch"
    | "core-event-kinds-mismatch"
    | "donor-domain-present"
    | "donor-dependency"
    | "donor-source-import"
    | "forbidden-dependency"
    | "forbidden-domain-import"
    | "forbidden-domain-path"
    | "forbidden-import"
    | "invalid-package-manifest"
    | "relative-import-escape"
    | "workspace-dependency"
    | "workspace-package-name";
  readonly message: string;
  readonly path: string;
  readonly line?: number;
  readonly packageName?: string;
  readonly specifier?: string;
}

export interface SurfaceBudgetReport {
  readonly workspaceRoot: string;
  readonly entryPackagePath: string;
  readonly packages: ReadonlyArray<string>;
  readonly sourceFilesScanned: number;
  readonly violations: ReadonlyArray<SurfaceBudgetViolation>;
  readonly warnings: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(manifestPath: string): WorkspacePackage {
  const root = NodePath.dirname(manifestPath);

  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    if (!isRecord(parsed)) {
      return { root, manifestPath, manifestError: "package.json must contain an object" };
    }

    const manifest = parsed as PackageManifest;
    return {
      root,
      manifestPath,
      manifest,
      name: typeof manifest.name === "string" ? manifest.name : undefined,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { root, manifestPath, manifestError: detail };
  }
}

function collectWorkspacePackages(workspaceRoot: string): ReadonlyArray<WorkspacePackage> {
  const packageJsonPaths = new Set<string>();

  for (const containerName of ["apps", "infra", "integrations", "packages"]) {
    const container = NodePath.join(workspaceRoot, containerName);
    if (!NodeFS.existsSync(container)) {
      continue;
    }

    for (const entry of NodeFS.readdirSync(container, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) {
        continue;
      }

      const manifestPath = NodePath.join(container, entry.name, "package.json");
      if (NodeFS.existsSync(manifestPath)) {
        packageJsonPaths.add(manifestPath);
      }
    }
  }

  const scriptsManifest = NodePath.join(workspaceRoot, "scripts", "package.json");
  if (NodeFS.existsSync(scriptsManifest)) {
    packageJsonPaths.add(scriptsManifest);
  }

  return [...packageJsonPaths].sort().map(parseManifest);
}

function isAllowedTnanoPackageName(name: string): boolean {
  return name === "t-nano" || name.startsWith("@t-nano/");
}

function dependencyEntries(
  manifest: PackageManifest,
  section: DependencySection,
): ReadonlyArray<readonly [string, string]> {
  const value = manifest[section];
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
}

function dependencyFamily(specifier: string): string | undefined {
  const packageName = barePackageName(specifier).toLowerCase();

  if (
    packageName === "react" ||
    packageName === "react-dom" ||
    packageName === "react-native" ||
    packageName.startsWith("react-") ||
    packageName.startsWith("@react-") ||
    packageName.startsWith("@react/")
  ) {
    return "React";
  }
  if (packageName === "electron" || packageName.startsWith("@electron/")) {
    return "Electron";
  }
  if (
    packageName === "expo" ||
    packageName.startsWith("expo-") ||
    packageName.startsWith("@expo/")
  ) {
    return "Expo";
  }
  if (packageName.startsWith("@clerk/")) {
    return "Clerk";
  }
  if (
    packageName === "posthog" ||
    packageName.startsWith("posthog-") ||
    packageName.startsWith("@posthog/")
  ) {
    return "PostHog";
  }
  if (packageName.startsWith("@opentelemetry/") || packageName.startsWith("opentelemetry")) {
    return "OpenTelemetry";
  }
  if (
    packageName === "pg" ||
    packageName === "postgres" ||
    packageName === "mysql" ||
    packageName === "mysql2" ||
    packageName === "sqlite" ||
    packageName === "sqlite3" ||
    packageName === "better-sqlite3" ||
    packageName === "knex" ||
    packageName === "sequelize" ||
    packageName === "typeorm" ||
    packageName === "drizzle-orm" ||
    packageName === "prisma" ||
    packageName.startsWith("@prisma/") ||
    packageName.startsWith("@effect/sql")
  ) {
    return "SQL";
  }
  if (packageName === "node-pty" || packageName.startsWith("@homebridge/node-pty")) {
    return "node-pty";
  }
  if (
    packageName === "playwright" ||
    packageName === "playwright-core" ||
    packageName.startsWith("@playwright/")
  ) {
    return "Playwright";
  }
  if (
    packageName === "ssh" ||
    packageName === "ssh2" ||
    packageName === "node-ssh" ||
    packageName.startsWith("@t-nano/ssh") ||
    packageName.startsWith("@t3tools/ssh")
  ) {
    return "SSH";
  }
  if (
    packageName === "tailscale" ||
    packageName.startsWith("@tailscale/") ||
    packageName.startsWith("@t-nano/tailscale") ||
    packageName.startsWith("@t3tools/tailscale")
  ) {
    return "Tailscale";
  }
  if (
    packageName === "simple-git" ||
    packageName === "isomorphic-git" ||
    packageName === "dugite" ||
    packageName === "nodegit"
  ) {
    return "Git";
  }
  if (
    packageName.startsWith("@modelcontextprotocol/") ||
    packageName === "mcp" ||
    packageName.startsWith("mcp-")
  ) {
    return "MCP";
  }

  return undefined;
}

function barePackageName(specifier: string): string {
  if (!specifier.startsWith("@")) {
    return specifier.split("/", 1)[0] ?? specifier;
  }

  const [scope, name] = specifier.split("/");
  return name === undefined ? scope : `${scope}/${name}`;
}

function normalizedDomainParts(value: string): ReadonlyArray<string> {
  const parts: Array<string> = [];

  for (const segment of value.split(/[\\/]/u)) {
    const normalized = segment.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (normalized.length > 0) {
      parts.push(normalized);
    }
    for (const word of segment.toLowerCase().split(/[^a-z0-9]+/u)) {
      if (word.length > 0) {
        parts.push(word);
      }
    }
  }

  return parts;
}

function forbiddenDomain(value: string): string | undefined {
  return normalizedDomainParts(value).find((part) => forbiddenDomainNames.has(part));
}

function isInside(parent: string, target: string): boolean {
  const relative = NodePath.relative(parent, target);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
}

function decodeString(raw: string): string {
  return raw.replace(/\\([\\'"`])/gu, "$1");
}

function tokenize(source: string): ReadonlyArray<Token> {
  const tokens: Array<Token> = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length) {
        if (source[index] === "\n") {
          line += 1;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const tokenLine = line;
      let value = "";
      index += 1;
      while (index < source.length) {
        const current = source[index] ?? "";
        if (current === "\\") {
          value += current;
          index += 1;
          if (index < source.length) {
            value += source[index] ?? "";
            index += 1;
          }
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        if (current === "\n") {
          line += 1;
        }
        value += current;
        index += 1;
      }
      tokens.push({ kind: "string", value: decodeString(value), line: tokenLine });
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length) {
        const current = source[index] ?? "";
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "\n") {
          line += 1;
        }
        index += 1;
        if (current === "`") {
          break;
        }
      }
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const tokenLine = line;
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index] ?? "")) {
        index += 1;
      }
      tokens.push({ kind: "identifier", value: source.slice(start, index), line: tokenLine });
      continue;
    }

    tokens.push({ kind: "punctuation", value: character, line });
    index += 1;
  }

  return tokens;
}

function findFromSpecifier(tokens: ReadonlyArray<Token>, start: number): Token | undefined {
  let depth = 0;

  for (let index = start; index < Math.min(tokens.length, start + 100); index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token.value === "(" || token.value === "[" || token.value === "{") {
      depth += 1;
      continue;
    }
    if (token.value === ")" || token.value === "]" || token.value === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && token.value === ";") {
      return undefined;
    }
    if (depth === 0 && token.kind === "identifier" && token.value === "from") {
      const specifier = tokens[index + 1];
      return specifier?.kind === "string" ? specifier : undefined;
    }
  }

  return undefined;
}

function collectImports(source: string): ReadonlyArray<SourceImport> {
  const tokens = tokenize(source);
  const imports: Array<SourceImport> = [];
  const seen = new Set<string>();

  const add = (token: Token, dynamic: boolean) => {
    const key = `${token.line}:${dynamic ? "dynamic" : "static"}:${token.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      imports.push({ specifier: token.value, line: token.line, dynamic });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier") {
      continue;
    }

    if (token.value === "require" && tokens[index + 1]?.value === "(") {
      const specifier = tokens[index + 2];
      if (specifier?.kind === "string") {
        add(specifier, true);
      }
      continue;
    }

    if (token.value === "import") {
      const next = tokens[index + 1];
      if (next?.kind === "string") {
        add(next, false);
        continue;
      }
      if (next?.value === "(") {
        const specifier = tokens[index + 2];
        if (specifier?.kind === "string") {
          add(specifier, true);
        }
        continue;
      }
      if (next?.value === ".") {
        continue;
      }
      const specifier = findFromSpecifier(tokens, index + 1);
      if (specifier !== undefined) {
        add(specifier, false);
      }
      continue;
    }

    if (token.value === "export") {
      const specifier = findFromSpecifier(tokens, index + 1);
      if (specifier !== undefined) {
        add(specifier, false);
      }
    }
  }

  return imports;
}

function exportedStringArrays(source: string): ReadonlyArray<ExportedStringArray> {
  const tokens = tokenize(source);
  const arrays: Array<ExportedStringArray> = [];

  for (let index = 0; index < tokens.length - 2; index += 1) {
    const exportToken = tokens[index];
    const constToken = tokens[index + 1];
    const nameToken = tokens[index + 2];
    if (
      exportToken?.value !== "export" ||
      constToken?.value !== "const" ||
      nameToken?.kind !== "identifier" ||
      (!eventKindConstantNames.has(nameToken.value) && !cliModeConstantNames.has(nameToken.value))
    ) {
      continue;
    }

    let equalsIndex = -1;
    for (let cursor = index + 3; cursor < Math.min(tokens.length, index + 50); cursor += 1) {
      if (tokens[cursor]?.value === ";") {
        break;
      }
      if (tokens[cursor]?.value === "=") {
        equalsIndex = cursor;
        break;
      }
    }
    if (equalsIndex < 0) {
      continue;
    }

    let openIndex = -1;
    for (
      let cursor = equalsIndex + 1;
      cursor < Math.min(tokens.length, equalsIndex + 20);
      cursor += 1
    ) {
      if (tokens[cursor]?.value === "[") {
        openIndex = cursor;
        break;
      }
      if (tokens[cursor]?.value === ";") {
        break;
      }
    }
    if (openIndex < 0) {
      continue;
    }

    const values: Array<string> = [];
    let depth = 0;
    for (let cursor = openIndex; cursor < tokens.length; cursor += 1) {
      const current = tokens[cursor];
      if (current?.value === "[") {
        depth += 1;
        continue;
      }
      if (current?.value === "]") {
        depth -= 1;
        if (depth === 0) {
          arrays.push({ name: nameToken.value, values, line: nameToken.line });
          break;
        }
        continue;
      }
      if (depth === 1 && current?.kind === "string") {
        values.push(current.value);
      }
    }
  }

  return arrays;
}

function collectRuntimeSources(packageRoot: string): ReadonlyArray<string> {
  const files: Array<string> = [];

  const visit = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          visit(entryPath);
        }
        continue;
      }
      if (
        entry.isFile() &&
        sourceExtensions.has(NodePath.extname(entry.name)) &&
        !/\.(?:d|spec|test)\.[cm]?[jt]sx?$/u.test(entry.name)
      ) {
        files.push(entryPath);
      }
    }
  };

  visit(packageRoot);
  return files.sort();
}

function packageForSpecifier(
  specifier: string,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage | undefined {
  let match: WorkspacePackage | undefined;
  for (const [name, workspacePackage] of packagesByName) {
    if (
      (specifier === name || specifier.startsWith(`${name}/`)) &&
      (match?.name?.length ?? 0) < name.length
    ) {
      match = workspacePackage;
    }
  }
  return match;
}

function donorTargetForPath(
  workspaceRoot: string,
  target: string,
  packages: ReadonlyArray<WorkspacePackage>,
): WorkspacePackage | undefined {
  const candidates = packages
    .filter((workspacePackage) => isInside(workspacePackage.root, target))
    .sort((left, right) => right.root.length - left.root.length);
  const match = candidates[0];
  if (match !== undefined && (match.name === undefined || !isAllowedTnanoPackageName(match.name))) {
    return match;
  }

  const relative = NodePath.relative(workspaceRoot, target);
  const [container, child] = relative.split(NodePath.sep);
  if (
    (container === "apps" || container === "packages") &&
    child !== undefined &&
    match === undefined
  ) {
    return {
      root: NodePath.join(workspaceRoot, container, child),
      manifestPath: NodePath.join(workspaceRoot, container, child, "package.json"),
      name: `${container}/${child}`,
    };
  }

  return undefined;
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function inspectTnanoSurface(workspaceRootInput: string): SurfaceBudgetReport {
  const workspaceRoot = NodePath.resolve(workspaceRootInput);
  const entryPackagePath = NodePath.join(workspaceRoot, "apps", "tnano", "package.json");
  const violations: Array<SurfaceBudgetViolation> = [];
  const warnings: Array<string> = [];
  const violationKeys = new Set<string>();
  const addViolation = (violation: SurfaceBudgetViolation) => {
    const key = `${violation.code}:${violation.path}:${violation.line ?? 0}:${violation.specifier ?? ""}`;
    if (!violationKeys.has(key)) {
      violationKeys.add(key);
      violations.push(violation);
    }
  };

  for (const relativePath of REMOVED_DONOR_PATHS) {
    const removedPath = NodePath.join(workspaceRoot, relativePath);
    if (NodeFS.existsSync(removedPath)) {
      addViolation({
        code: "donor-domain-present",
        message: `Physically removed donor product domain '${relativePath}' must not re-enter the T-Nano tree.`,
        path: removedPath,
      });
    }
  }

  if (!NodeFS.existsSync(entryPackagePath)) {
    warnings.push(
      `T-Nano entry package is not present at ${NodePath.relative(workspaceRoot, entryPackagePath)}; surface checks are deferred.`,
    );
    return {
      workspaceRoot,
      entryPackagePath,
      packages: [],
      sourceFilesScanned: 0,
      violations: [],
      warnings,
    };
  }

  const discoveredPackages = collectWorkspacePackages(workspaceRoot);
  const packagesByRoot = new Map(
    discoveredPackages.map((workspacePackage) => [workspacePackage.root, workspacePackage]),
  );
  const parsedEntry = parseManifest(entryPackagePath);
  packagesByRoot.set(parsedEntry.root, parsedEntry);
  const allPackages = [...packagesByRoot.values()];
  const packagesByName = new Map<string, WorkspacePackage>();
  for (const workspacePackage of allPackages) {
    if (workspacePackage.name !== undefined) {
      packagesByName.set(workspacePackage.name, workspacePackage);
    }
  }

  const reachable: Array<WorkspacePackage> = [];
  const queue: Array<WorkspacePackage> = [parsedEntry];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const workspacePackage = queue.shift();
    if (workspacePackage === undefined || visited.has(workspacePackage.root)) {
      continue;
    }
    visited.add(workspacePackage.root);
    reachable.push(workspacePackage);

    if (workspacePackage.manifestError !== undefined || workspacePackage.manifest === undefined) {
      addViolation({
        code: "invalid-package-manifest",
        message: `Cannot read package manifest: ${workspacePackage.manifestError ?? "unknown error"}.`,
        path: workspacePackage.manifestPath,
        packageName: workspacePackage.name,
      });
      continue;
    }

    if (workspacePackage.name === undefined || !isAllowedTnanoPackageName(workspacePackage.name)) {
      addViolation({
        code: "workspace-package-name",
        message: `Reachable workspace package must be named 't-nano' or '@t-nano/*', found '${workspacePackage.name ?? "<missing>"}'.`,
        path: workspacePackage.manifestPath,
        packageName: workspacePackage.name,
      });
    }

    for (const section of dependencySections) {
      for (const [dependencyName, version] of dependencyEntries(
        workspacePackage.manifest,
        section,
      )) {
        if (dependencyName === "@t3tools" || dependencyName.startsWith("@t3tools/")) {
          addViolation({
            code: "donor-dependency",
            message: `${section} contains donor dependency '${dependencyName}'.`,
            path: workspacePackage.manifestPath,
            packageName: workspacePackage.name,
            specifier: dependencyName,
          });
        }

        if (runtimeDependencySections.has(section)) {
          const family = dependencyFamily(dependencyName);
          if (family !== undefined) {
            addViolation({
              code: "forbidden-dependency",
              message: `${section} contains forbidden ${family} dependency '${dependencyName}'.`,
              path: workspacePackage.manifestPath,
              packageName: workspacePackage.name,
              specifier: dependencyName,
            });
          }
          const domain = forbiddenDomain(dependencyName);
          if (domain !== undefined) {
            addViolation({
              code: "forbidden-dependency",
              message: `${section} contains forbidden product-domain dependency '${dependencyName}' (${domain}).`,
              path: workspacePackage.manifestPath,
              packageName: workspacePackage.name,
              specifier: dependencyName,
            });
          }
        }

        const localDependency = packagesByName.get(dependencyName);
        const requestsWorkspacePackage = version.startsWith("workspace:");
        if (localDependency === undefined) {
          if (requestsWorkspacePackage && isAllowedTnanoPackageName(dependencyName)) {
            warnings.push(
              `${workspacePackage.name ?? workspacePackage.root} references missing early-development package '${dependencyName}'.`,
            );
          } else if (requestsWorkspacePackage) {
            addViolation({
              code: "workspace-dependency",
              message: `Workspace dependency '${dependencyName}' is not a T-Nano package and is not present.`,
              path: workspacePackage.manifestPath,
              packageName: workspacePackage.name,
              specifier: dependencyName,
            });
          }
          continue;
        }

        if (
          localDependency.name === undefined ||
          !isAllowedTnanoPackageName(localDependency.name)
        ) {
          addViolation({
            code: "workspace-dependency",
            message: `Dependency '${dependencyName}' resolves to a donor or non-T-Nano workspace package.`,
            path: workspacePackage.manifestPath,
            packageName: workspacePackage.name,
            specifier: dependencyName,
          });
          continue;
        }

        queue.push(localDependency);
      }
    }
  }

  let sourceFilesScanned = 0;
  let eventKindsFound = false;
  let cliModesFound = false;

  for (const workspacePackage of reachable) {
    if (workspacePackage.manifest === undefined || workspacePackage.manifestError !== undefined) {
      continue;
    }

    for (const sourcePath of collectRuntimeSources(workspacePackage.root)) {
      sourceFilesScanned += 1;
      const relativeSourcePath = NodePath.relative(workspacePackage.root, sourcePath);
      const domain = forbiddenDomain(relativeSourcePath);
      if (domain !== undefined) {
        addViolation({
          code: "forbidden-domain-path",
          message: `Runtime source path belongs to forbidden product domain '${domain}'.`,
          path: sourcePath,
          packageName: workspacePackage.name,
        });
      }

      const source = NodeFS.readFileSync(sourcePath, "utf8");
      for (const exportedArray of exportedStringArrays(source)) {
        if (eventKindConstantNames.has(exportedArray.name)) {
          eventKindsFound = true;
          if (!arraysEqual(exportedArray.values, ALLOWED_CORE_EVENT_KINDS)) {
            addViolation({
              code: "core-event-kinds-mismatch",
              message: `Exported ${exportedArray.name} must equal ${JSON.stringify(ALLOWED_CORE_EVENT_KINDS)}, found ${JSON.stringify(exportedArray.values)}.`,
              path: sourcePath,
              line: exportedArray.line,
              packageName: workspacePackage.name,
            });
          }
        }
        if (cliModeConstantNames.has(exportedArray.name)) {
          cliModesFound = true;
          if (!arraysEqual(exportedArray.values, ALLOWED_CLI_MODE_NAMES)) {
            addViolation({
              code: "cli-mode-names-mismatch",
              message: `Exported ${exportedArray.name} must equal ${JSON.stringify(ALLOWED_CLI_MODE_NAMES)}, found ${JSON.stringify(exportedArray.values)}.`,
              path: sourcePath,
              line: exportedArray.line,
              packageName: workspacePackage.name,
            });
          }
        }
      }

      for (const sourceImport of collectImports(source)) {
        const specifier = sourceImport.specifier;
        const sourceContext = sourceImport.dynamic ? "Dynamic import" : "Import";
        const cleanSpecifier = specifier.split(/[?#]/u, 1)[0] ?? specifier;

        if (specifier === "@t3tools" || specifier.startsWith("@t3tools/")) {
          addViolation({
            code: "donor-source-import",
            message: `${sourceContext} reaches donor module '${specifier}'.`,
            path: sourcePath,
            line: sourceImport.line,
            packageName: workspacePackage.name,
            specifier,
          });
        }

        if (cleanSpecifier.startsWith(".")) {
          const target = NodePath.resolve(NodePath.dirname(sourcePath), cleanSpecifier);
          if (!isInside(workspacePackage.root, target)) {
            addViolation({
              code: "relative-import-escape",
              message: `${sourceContext} '${specifier}' escapes package '${workspacePackage.name ?? workspacePackage.root}'.`,
              path: sourcePath,
              line: sourceImport.line,
              packageName: workspacePackage.name,
              specifier,
            });

            const donorTarget = donorTargetForPath(workspaceRoot, target, allPackages);
            if (donorTarget !== undefined) {
              addViolation({
                code: "donor-source-import",
                message: `${sourceContext} '${specifier}' reaches donor source '${donorTarget.name ?? donorTarget.root}'.`,
                path: sourcePath,
                line: sourceImport.line,
                packageName: workspacePackage.name,
                specifier,
              });
            }
          }
        } else if (NodePath.isAbsolute(cleanSpecifier)) {
          const donorTarget = donorTargetForPath(workspaceRoot, cleanSpecifier, allPackages);
          if (donorTarget !== undefined) {
            addViolation({
              code: "donor-source-import",
              message: `${sourceContext} '${specifier}' reaches donor source '${donorTarget.name ?? donorTarget.root}'.`,
              path: sourcePath,
              line: sourceImport.line,
              packageName: workspacePackage.name,
              specifier,
            });
          }
        } else if (!cleanSpecifier.startsWith("node:")) {
          const importedWorkspacePackage = packageForSpecifier(cleanSpecifier, packagesByName);
          if (
            importedWorkspacePackage !== undefined &&
            (importedWorkspacePackage.name === undefined ||
              !isAllowedTnanoPackageName(importedWorkspacePackage.name))
          ) {
            addViolation({
              code: "donor-source-import",
              message: `${sourceContext} reaches donor workspace package '${importedWorkspacePackage.name ?? cleanSpecifier}'.`,
              path: sourcePath,
              line: sourceImport.line,
              packageName: workspacePackage.name,
              specifier,
            });
          }

          if (cleanSpecifier.startsWith("apps/") || cleanSpecifier.startsWith("packages/")) {
            addViolation({
              code: "donor-source-import",
              message: `${sourceContext} reaches workspace source path '${specifier}' instead of a T-Nano package export.`,
              path: sourcePath,
              line: sourceImport.line,
              packageName: workspacePackage.name,
              specifier,
            });
          }

          const family = dependencyFamily(cleanSpecifier);
          if (family !== undefined) {
            addViolation({
              code: "forbidden-import",
              message: `${sourceContext} reaches forbidden ${family} runtime '${specifier}'.`,
              path: sourcePath,
              line: sourceImport.line,
              packageName: workspacePackage.name,
              specifier,
            });
          }
        }

        const importDomain = forbiddenDomain(cleanSpecifier);
        if (importDomain !== undefined) {
          addViolation({
            code: "forbidden-domain-import",
            message: `${sourceContext} reaches forbidden product domain '${importDomain}' through '${specifier}'.`,
            path: sourcePath,
            line: sourceImport.line,
            packageName: workspacePackage.name,
            specifier,
          });
        }
      }
    }
  }

  if (!eventKindsFound) {
    warnings.push(
      `No exported core event-kind constant was found; expected one of ${[...eventKindConstantNames].join(", ")}.`,
    );
  }
  if (!cliModesFound) {
    warnings.push(
      `No exported CLI mode constant was found; expected one of ${[...cliModeConstantNames].join(", ")}.`,
    );
  }

  violations.sort((left, right) => {
    const pathOrder = left.path.localeCompare(right.path);
    return pathOrder !== 0 ? pathOrder : (left.line ?? 0) - (right.line ?? 0);
  });

  return {
    workspaceRoot,
    entryPackagePath,
    packages: reachable
      .map((workspacePackage) => workspacePackage.name ?? workspacePackage.root)
      .sort(),
    sourceFilesScanned,
    violations,
    warnings: [...new Set(warnings)].sort(),
  };
}

export function formatSurfaceBudgetReport(report: SurfaceBudgetReport): string {
  const lines: Array<string> = [];
  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const violation of report.violations) {
    const relativePath = NodePath.relative(report.workspaceRoot, violation.path) || ".";
    const location =
      violation.line === undefined ? relativePath : `${relativePath}:${violation.line}`;
    lines.push(`error [${violation.code}] ${location}: ${violation.message}`);
  }

  if (report.violations.length === 0) {
    lines.push(
      `T-Nano surface budget passed (${report.packages.length} package${report.packages.length === 1 ? "" : "s"}, ${report.sourceFilesScanned} runtime source file${report.sourceFilesScanned === 1 ? "" : "s"}).`,
    );
  } else {
    lines.push(
      `T-Nano surface budget failed with ${report.violations.length} violation${report.violations.length === 1 ? "" : "s"}.`,
    );
  }

  return lines.join("\n");
}

const defaultWorkspaceRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const invokedPath =
  process.argv[1] === undefined
    ? undefined
    : NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  const workspaceRoot =
    process.argv[2] === undefined ? defaultWorkspaceRoot : NodePath.resolve(process.argv[2]);
  const report = inspectTnanoSurface(workspaceRoot);
  const output = formatSurfaceBudgetReport(report);
  if (report.violations.length > 0) {
    console.error(output);
    process.exitCode = 1;
  } else {
    console.log(output);
  }
}
