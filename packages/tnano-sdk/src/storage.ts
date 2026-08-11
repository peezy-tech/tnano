// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Human-inspectable atomic JSON and JSONL persistence intentionally uses Node primitives and diagnostic wall-clock time.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { TNanoError } from "./errors.ts";
import type {
  HarnessEvent,
  HarnessProfile,
  JsonObject,
  RuntimeSettings,
  SessionBinding,
} from "./types.ts";

interface ProfilesDocument {
  readonly version: 1;
  readonly profiles: readonly HarnessProfile[];
}

const EMPTY_PROFILES: ProfilesDocument = { version: 1, profiles: [] };
const EMPTY_SETTINGS: RuntimeSettings = { version: 1, values: {} };

let temporaryFileCounter = 0;

interface SessionLeaseOwner {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

/**
 * Exclusive ownership of one persisted session.
 *
 * The token is checked again before unlinking so one runtime never knowingly
 * releases another runtime's lease. Existing or malformed leases are left in
 * place: automatic stale recovery is intentionally omitted because liveness
 * cannot be established safely across hosts or permission boundaries.
 */
export class SessionLease {
  readonly #path: string;
  readonly #owner: SessionLeaseOwner;
  #released = false;

  constructor(path: string, owner: SessionLeaseOwner) {
    this.#path = path;
    this.#owner = owner;
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }

    let persisted: unknown;
    try {
      persisted = JSON.parse(await NodeFSP.readFile(this.#path, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFileError(error)) {
        // The lease no longer exists, so there is nothing this owner can safely
        // remove. Treat this instance as released without touching the path.
        this.#released = true;
        return;
      }
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Could not verify T-Nano session lease: ${this.#path}`,
      );
    }

    if (!isSessionLeaseOwner(persisted) || !sameLeaseOwner(persisted, this.#owner)) {
      throw new TNanoError(
        "INVALID_STATE",
        `T-Nano session lease ownership changed before release: ${this.#path}`,
      );
    }

    try {
      await NodeFSP.unlink(this.#path);
      this.#released = true;
    } catch (error) {
      if (isMissingFileError(error)) {
        this.#released = true;
        return;
      }
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Could not release T-Nano session lease: ${this.#path}`,
      );
    }
  }
}

export class FileRuntimeStore {
  readonly #root: string;

  constructor(root: string) {
    if (root.trim() === "") {
      throw new TNanoError("INVALID_ARGUMENT", "Runtime data directory cannot be empty");
    }
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  async initialize(): Promise<void> {
    try {
      await NodeFSP.mkdir(NodePath.join(this.#root, "sessions"), {
        recursive: true,
        mode: 0o700,
      });
      if (!(await exists(NodePath.join(this.#root, "profiles.json")))) {
        await atomicWriteJson(NodePath.join(this.#root, "profiles.json"), EMPTY_PROFILES);
      }
      if (!(await exists(NodePath.join(this.#root, "settings.json")))) {
        await atomicWriteJson(NodePath.join(this.#root, "settings.json"), EMPTY_SETTINGS);
      }
    } catch (error) {
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Could not initialize T-Nano data directory: ${this.#root}`,
      );
    }
  }

  async readProfiles(): Promise<readonly HarnessProfile[]> {
    const value = await readJson(NodePath.join(this.#root, "profiles.json"));
    if (!isProfilesDocument(value)) {
      throw invalidFile("profiles.json");
    }
    return value.profiles;
  }

  async writeProfiles(profiles: readonly HarnessProfile[]): Promise<void> {
    const document: ProfilesDocument = {
      version: 1,
      profiles: [...profiles].sort((left, right) => left.id.localeCompare(right.id)),
    };
    await atomicWriteJson(NodePath.join(this.#root, "profiles.json"), document);
  }

  async readSettings(): Promise<RuntimeSettings> {
    const value = await readJson(NodePath.join(this.#root, "settings.json"));
    if (!isRuntimeSettings(value)) {
      throw invalidFile("settings.json");
    }
    return value;
  }

  async writeSettings(settings: RuntimeSettings): Promise<void> {
    await atomicWriteJson(NodePath.join(this.#root, "settings.json"), settings);
  }

  async hasSession(sessionId: string): Promise<boolean> {
    return exists(this.bindingPath(sessionId));
  }

  async acquireSessionLease(sessionId: string): Promise<SessionLease> {
    const directory = this.sessionDirectory(sessionId);
    const path = NodePath.join(directory, ".lease");
    const reclaimPath = NodePath.join(directory, ".lease.reclaim");
    try {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      const owner: SessionLeaseOwner = {
        version: 1,
        token: NodeCrypto.randomUUID(),
        pid: process.pid,
        hostname: NodeOS.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      if (await exists(reclaimPath)) {
        throw sessionLeaseBusy(sessionId, "reclamation-in-progress");
      }
      if (await tryCreateSessionLease(path, owner)) {
        return new SessionLease(path, owner);
      }

      const observedOwner = await readSessionLeaseOwner(path, sessionId);
      if (
        observedOwner.hostname === owner.hostname &&
        processLiveness(observedOwner.pid) === "dead" &&
        (await reclaimStaleSessionLease(path, reclaimPath, observedOwner, owner, sessionId)) &&
        (await tryCreateSessionLease(path, owner))
      ) {
        return new SessionLease(path, owner);
      }
      throw sessionLeaseConflict(observedOwner, sessionId);
    } catch (error) {
      if (error instanceof TNanoError) {
        throw error;
      }
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Could not acquire T-Nano session lease: ${sessionId}`,
        { sessionId },
      );
    }
  }

  async readBinding(sessionId: string): Promise<SessionBinding> {
    const path = this.bindingPath(sessionId);
    let value: unknown;
    try {
      value = await readJson(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new TNanoError("SESSION_NOT_FOUND", `Session does not exist: ${sessionId}`, {
          details: { sessionId },
        });
      }
      throw error;
    }
    if (!isSessionBinding(value)) {
      throw invalidFile(path);
    }
    return value;
  }

  async writeBinding(binding: SessionBinding): Promise<void> {
    const directory = this.sessionDirectory(binding.sessionId);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWriteJson(NodePath.join(directory, "binding.json"), binding);
  }

  async listBindings(): Promise<readonly SessionBinding[]> {
    let entries;
    try {
      entries = await NodeFSP.readdir(NodePath.join(this.#root, "sessions"), {
        withFileTypes: true,
      });
    } catch (error) {
      throw TNanoError.from(error, "STORAGE_ERROR", "Could not list T-Nano sessions");
    }
    const bindings: SessionBinding[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        bindings.push(await this.readBinding(entry.name));
      } catch (error) {
        if (error instanceof TNanoError && error.code === "SESSION_NOT_FOUND") {
          continue;
        }
        throw error;
      }
    }
    return bindings.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );
  }

  async appendEvent(event: HarnessEvent): Promise<void> {
    const directory = this.sessionDirectory(event.sessionId);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const line = `${serializeJson(event)}\n`;
    try {
      await NodeFSP.appendFile(NodePath.join(directory, "events.jsonl"), line, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Could not append event for session: ${event.sessionId}`,
        { sessionId: event.sessionId },
      );
    }
  }

  async readEvents(sessionId: string): Promise<readonly HarnessEvent[]> {
    const path = NodePath.join(this.sessionDirectory(sessionId), "events.jsonl");
    let text: string;
    try {
      text = await NodeFSP.readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Could not read events for session: ${sessionId}`,
      );
    }
    if (text === "") {
      return [];
    }
    try {
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as HarnessEvent);
    } catch (error) {
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Session event log contains invalid JSON: ${sessionId}`,
      );
    }
  }

  /**
   * Recover the durable sequence without requiring a power-loss-truncated final
   * JSONL fragment to parse. Any malformed complete or non-final record remains
   * a hard storage error; public event reads remain strict as well.
   */
  async readLastEventSequenceForResume(sessionId: string): Promise<number> {
    const path = NodePath.join(this.sessionDirectory(sessionId), "events.jsonl");
    let text: string;
    try {
      text = await NodeFSP.readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return 0;
      }
      throw TNanoError.from(
        error,
        "STORAGE_ERROR",
        `Could not read events for session resume: ${sessionId}`,
      );
    }
    if (text === "") {
      return 0;
    }

    const hasUnterminatedTail = !text.endsWith("\n");
    const lines = text.split("\n");
    if (!hasUnterminatedTail) {
      lines.pop();
    }
    let lastSequence = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line === "") {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch (error) {
        if (hasUnterminatedTail && index === lines.length - 1) {
          return lastSequence;
        }
        throw TNanoError.from(
          error,
          "STORAGE_ERROR",
          `Session event log contains invalid JSON before its tail: ${sessionId}`,
        );
      }
      if (
        !isRecord(event) ||
        typeof event.sequence !== "number" ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1
      ) {
        throw new TNanoError(
          "STORAGE_ERROR",
          `Session event log contains an invalid sequence: ${sessionId}`,
        );
      }
      lastSequence = event.sequence;
    }
    return lastSequence;
  }

  bindingPath(sessionId: string): string {
    return NodePath.join(this.sessionDirectory(sessionId), "binding.json");
  }

  eventsPath(sessionId: string): string {
    return NodePath.join(this.sessionDirectory(sessionId), "events.jsonl");
  }

  private sessionDirectory(sessionId: string): string {
    assertSafeId(sessionId, "session id");
    return NodePath.join(this.#root, "sessions", sessionId);
  }
}

export function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TNanoError(
      "INVALID_ARGUMENT",
      `${label} must use 1-128 letters, numbers, dots, underscores, or hyphens`,
      { details: { value } },
    );
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const text = `${serializeJson(value, true)}\n`;
  const counter = temporaryFileCounter++;
  const temporaryPath = NodePath.join(
    NodePath.join(path, ".."),
    `.${NodePath.basename(path)}.${process.pid}.${counter}.tmp`,
  );
  let handle;
  try {
    await NodeFSP.mkdir(NodePath.join(path, ".."), {
      recursive: true,
      mode: 0o700,
    });
    handle = await NodeFSP.open(temporaryPath, "w", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(temporaryPath, path);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await NodeFSP.unlink(temporaryPath).catch(() => undefined);
    throw TNanoError.from(
      error,
      "STORAGE_ERROR",
      `Could not atomically write T-Nano state: ${path}`,
    );
  }
}

function serializeJson(value: unknown, pretty = false): string {
  try {
    const serialized = JSON.stringify(value, undefined, pretty ? 2 : undefined);
    if (serialized === undefined) {
      throw new TypeError("Value is not JSON serializable");
    }
    return serialized;
  } catch (error) {
    throw TNanoError.from(error, "INVALID_STATE", "Value is not JSON serializable");
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      throw error;
    }
    throw TNanoError.from(error, "STORAGE_ERROR", `Could not read T-Nano state: ${path}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.readFile(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function tryCreateSessionLease(path: string, owner: SessionLeaseOwner): Promise<boolean> {
  let handle;
  let created = false;
  try {
    handle = await NodeFSP.open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(`${serializeJson(owner, true)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return true;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (created) {
      await NodeFSP.unlink(path).catch(() => undefined);
    }
    if (isAlreadyExistsError(error)) {
      return false;
    }
    throw error;
  }
}

async function readSessionLeaseOwner(path: string, sessionId: string): Promise<SessionLeaseOwner> {
  let owner: unknown;
  try {
    owner = JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
  } catch {
    throw new TNanoError(
      "SESSION_ACTIVE",
      `Session lease already exists and cannot be verified: ${sessionId}`,
      { details: { sessionId, reason: "unreadable-lease" } },
    );
  }
  if (!isSessionLeaseOwner(owner)) {
    throw sessionLeaseBusy(sessionId, "invalid-lease");
  }
  return owner;
}

function sessionLeaseConflict(owner: SessionLeaseOwner, sessionId: string): TNanoError {
  return new TNanoError(
    "SESSION_ACTIVE",
    `Session is leased by another T-Nano runtime: ${sessionId}`,
    {
      details: {
        sessionId,
        ownerPid: owner.pid,
        ownerHostname: owner.hostname,
        ownerAcquiredAt: owner.acquiredAt,
      },
    },
  );
}

function sessionLeaseBusy(sessionId: string, reason: string): TNanoError {
  return new TNanoError("SESSION_ACTIVE", `Session lease cannot be acquired safely: ${sessionId}`, {
    details: { sessionId, reason },
  });
}

type ProcessLiveness = "alive" | "dead" | "ambiguous";

function processLiveness(pid: number): ProcessLiveness {
  try {
    // Signal 0 performs a liveness/permission probe and never sends a signal.
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return "dead";
    }
    return "ambiguous";
  }
}

async function reclaimStaleSessionLease(
  path: string,
  reclaimPath: string,
  observedOwner: SessionLeaseOwner,
  reclaimer: SessionLeaseOwner,
  sessionId: string,
): Promise<boolean> {
  let handle;
  let ownsReclaim = false;
  try {
    handle = await NodeFSP.open(reclaimPath, "wx", 0o600);
    ownsReclaim = true;
    await handle.writeFile(
      `${serializeJson(
        {
          version: 1,
          token: reclaimer.token,
          pid: reclaimer.pid,
          hostname: reclaimer.hostname,
          acquiredAt: reclaimer.acquiredAt,
          targetToken: observedOwner.token,
        },
        true,
      )}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      handle = undefined;
    }
    if (!ownsReclaim && isAlreadyExistsError(error)) {
      return false;
    }
    if (ownsReclaim) {
      await removeReclaimMarker(reclaimPath);
    }
    throw error;
  }

  let result = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const currentOwner = await readSessionLeaseOwner(path, sessionId);
    if (
      sameLeaseOwner(currentOwner, observedOwner) &&
      currentOwner.hostname === reclaimer.hostname &&
      processLiveness(currentOwner.pid) === "dead"
    ) {
      await NodeFSP.unlink(path);
      result = true;
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  // Cleanup failure intentionally wins, matching the former finally behavior:
  // a retained reclaim marker keeps future acquisition fail-closed.
  await removeReclaimMarker(reclaimPath);
  if (operationFailed) {
    throw operationError;
  }
  return result;
}

async function removeReclaimMarker(reclaimPath: string): Promise<void> {
  try {
    await NodeFSP.unlink(reclaimPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isSessionLeaseOwner(value: unknown): value is SessionLeaseOwner {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.token === "string" &&
    value.token !== "" &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.hostname === "string" &&
    value.hostname !== "" &&
    typeof value.acquiredAt === "string" &&
    value.acquiredAt !== ""
  );
}

function sameLeaseOwner(left: SessionLeaseOwner, right: SessionLeaseOwner): boolean {
  return (
    left.token === right.token &&
    left.pid === right.pid &&
    left.hostname === right.hostname &&
    left.acquiredAt === right.acquiredAt
  );
}

function invalidFile(path: string): TNanoError {
  return new TNanoError("STORAGE_ERROR", `T-Nano state has an invalid shape: ${path}`);
}

function isProfilesDocument(value: unknown): value is ProfilesDocument {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.profiles) &&
    value.profiles.every(isHarnessProfile)
  );
}

function isHarnessProfile(value: unknown): value is HarnessProfile {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.harness === "string" &&
    typeof value.label === "string" &&
    typeof value.enabled === "boolean" &&
    isRecord(value.config) &&
    (value.environment === undefined || isStringEnvironment(value.environment)) &&
    (value.defaultModel === undefined || typeof value.defaultModel === "string") &&
    (value.defaultOptions === undefined || isRecord(value.defaultOptions))
  );
}

function isRuntimeSettings(value: unknown): value is RuntimeSettings {
  return isRecord(value) && value.version === 1 && isRecord(value.values);
}

function isSessionBinding(value: unknown): value is SessionBinding {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sessionId === "string" &&
    typeof value.profileId === "string" &&
    typeof value.harnessId === "string" &&
    typeof value.adapterVersion === "string" &&
    typeof value.profileFingerprint === "string" &&
    typeof value.cwd === "string" &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.options === undefined || isRecord(value.options)) &&
    (value.title === undefined || typeof value.title === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Number.isSafeInteger(value.lastSequence) &&
    typeof value.lastSequence === "number"
  );
}

function isStringEnvironment(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => entry === null || typeof entry === "string")
  );
}

function isRecord(value: unknown): value is JsonObject & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
