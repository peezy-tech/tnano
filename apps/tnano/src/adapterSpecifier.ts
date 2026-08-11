// @effect-diagnostics nodeBuiltinImport:off - This package is the Node CLI boundary.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const PACKAGE_SEGMENT = /^[A-Za-z0-9_~][A-Za-z0-9._~-]*$/;
const isPackageSegment = (segment: string): boolean => PACKAGE_SEGMENT.test(segment);

function isBarePackageSpecifier(specifier: string): boolean {
  if (specifier.includes("\\") || specifier.includes(":")) return false;

  const segments = specifier.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }

  if (specifier.startsWith("@")) {
    if (segments.length < 2) return false;
    const scope = segments[0]?.slice(1);
    const packageName = segments[1];
    if (scope === undefined || packageName === undefined) return false;
    return PACKAGE_SEGMENT.test(scope) && segments.slice(1).every(isPackageSegment);
  }

  return segments.every(isPackageSegment);
}

export function trustedAdapterSpecifierIssue(specifier: string): string | undefined {
  if (specifier.trim() !== specifier || specifier.length === 0) {
    return "--adapter requires a non-empty specifier without surrounding whitespace";
  }

  if (NodePath.isAbsolute(specifier)) return undefined;

  if (specifier.startsWith("file:")) {
    try {
      const path = NodeURL.fileURLToPath(new URL(specifier));
      return NodePath.isAbsolute(path)
        ? undefined
        : `Adapter file URL must resolve to an absolute path: ${specifier}`;
    } catch {
      return `Invalid adapter file URL: ${specifier}`;
    }
  }

  if (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith(".\\") ||
    specifier.startsWith("..\\")
  ) {
    return `Relative or project-local adapter specifiers are not allowed: ${specifier}`;
  }

  if (!isBarePackageSpecifier(specifier)) {
    return `Adapter must be a bare package specifier, absolute path, or file URL: ${specifier}`;
  }

  return undefined;
}
