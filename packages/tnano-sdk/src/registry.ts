// @effect-diagnostics nodeBuiltinImport:off - T-Nano explicitly loads trusted local Node modules.
import * as NodeURL from "node:url";

import { TNanoError } from "./errors.ts";
import type { HarnessAdapter, HarnessManifest } from "./types.ts";

export type TrustedAdapterSpecifier = string | URL;

export class HarnessRegistry {
  readonly #adapters = new Map<string, HarnessAdapter>();

  register(adapter: HarnessAdapter): HarnessAdapter {
    assertAdapter(adapter);
    const id = adapter.manifest.id;
    if (this.#adapters.has(id)) {
      throw new TNanoError(
        "ADAPTER_ALREADY_REGISTERED",
        `Harness adapter is already registered: ${id}`,
        { details: { harnessId: id } },
      );
    }
    this.#adapters.set(id, adapter);
    return adapter;
  }

  get(id: string): HarnessAdapter | undefined {
    return this.#adapters.get(id);
  }

  require(id: string): HarnessAdapter {
    const adapter = this.get(id);
    if (adapter === undefined) {
      throw new TNanoError("ADAPTER_NOT_FOUND", `Harness adapter is not registered: ${id}`, {
        details: { harnessId: id },
      });
    }
    return adapter;
  }

  list(): readonly HarnessManifest[] {
    return [...this.#adapters.values()]
      .map((adapter) => adapter.manifest)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Load only a caller-supplied trusted module. No directory scanning or
   * project-local auto-loading occurs.
   *
   * A module may export an adapter as `default` or `adapter`, or an array as
   * `adapters`.
   */
  async load(specifier: TrustedAdapterSpecifier): Promise<readonly HarnessAdapter[]> {
    const importTarget = normalizeImportSpecifier(specifier);
    let moduleValue: unknown;
    try {
      moduleValue = await import(importTarget);
    } catch (error) {
      throw TNanoError.from(
        error,
        "INVALID_ADAPTER",
        `Could not load trusted harness adapter module: ${importTarget}`,
        { specifier: importTarget },
      );
    }

    const candidates = adapterCandidates(moduleValue);
    if (candidates.length === 0) {
      throw new TNanoError(
        "INVALID_ADAPTER",
        `Trusted module does not export an adapter: ${importTarget}`,
        { details: { specifier: importTarget } },
      );
    }
    return candidates.map((candidate) => this.register(candidate));
  }
}

function normalizeImportSpecifier(specifier: TrustedAdapterSpecifier): string {
  if (specifier instanceof URL) {
    return specifier.href;
  }
  if (specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) {
    return NodeURL.pathToFileURL(specifier).href;
  }
  return specifier;
}

function adapterCandidates(moduleValue: unknown): HarnessAdapter[] {
  if (!isRecord(moduleValue)) {
    return [];
  }
  const values: unknown[] = [moduleValue.default, moduleValue.adapter];
  if (Array.isArray(moduleValue.adapters)) {
    values.push(...moduleValue.adapters);
  }
  return values.filter(isHarnessAdapter);
}

function isHarnessAdapter(value: unknown): value is HarnessAdapter {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    return false;
  }
  return (
    value.manifest.apiVersion === 1 &&
    typeof value.manifest.id === "string" &&
    typeof value.manifest.label === "string" &&
    typeof value.manifest.version === "string" &&
    Array.isArray(value.manifest.capabilities) &&
    typeof value.probe === "function" &&
    typeof value.open === "function"
  );
}

function assertAdapter(adapter: HarnessAdapter): void {
  if (!isHarnessAdapter(adapter)) {
    throw new TNanoError("INVALID_ADAPTER", "Harness adapter does not implement API version 1");
  }
  if (adapter.manifest.id.trim() === "") {
    throw new TNanoError("INVALID_ADAPTER", "Harness adapter id cannot be empty");
  }
  if (!adapter.manifest.capabilities.every((entry) => typeof entry === "string")) {
    throw new TNanoError(
      "INVALID_ADAPTER",
      `Harness adapter has invalid capabilities: ${adapter.manifest.id}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
