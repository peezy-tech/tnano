export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const CORE_EVENT_KINDS = [
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

export type CoreEventKind = (typeof CORE_EVENT_KINDS)[number];

export interface HarnessManifest {
  readonly apiVersion: 1;
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly capabilities: readonly string[];
}

export interface HarnessProfile {
  readonly id: string;
  readonly harness: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly config: JsonObject;
  readonly environment?: Readonly<Record<string, string | null>>;
  readonly defaultModel?: string;
  readonly defaultOptions?: JsonObject;
}

export type ProbeStatus = "ready" | "unavailable" | "unauthenticated" | "error";

export interface ProbeAccount {
  readonly id?: string;
  readonly label?: string;
  readonly email?: string;
  readonly plan?: string;
}

export interface ProbeModel {
  readonly id: string;
  readonly label?: string;
  readonly available?: boolean;
  readonly metadata?: JsonObject;
}

/** Facts reported by an adapter. T-Nano does not infer billing or entitlement. */
export interface ProbeResult {
  readonly status: ProbeStatus;
  readonly message?: string;
  /** Version of the probed harness executable, when it can report one. */
  readonly version?: string;
  readonly account?: ProbeAccount;
  readonly models?: readonly ProbeModel[];
  readonly metadata?: JsonObject;
}

export interface ProfileProbeResult extends ProbeResult {
  readonly profileId: string;
  readonly harnessId: string;
  readonly observedAt: string;
}

export interface HarnessOpenInput {
  readonly profile: HarnessProfile;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly options?: JsonObject;
  readonly resume?: JsonValue;
  readonly signal?: AbortSignal;
}

export interface HarnessRunInput {
  readonly text: string;
  readonly attachments?: readonly JsonValue[];
  readonly signal?: AbortSignal;
}

export interface SessionStateEventInput {
  readonly type: "session.state";
  readonly state: string;
  readonly detail?: JsonValue;
}

export interface TurnStateEventInput {
  readonly type: "turn.state";
  readonly state: string;
  readonly detail?: JsonValue;
}

export interface ContentDeltaEventInput {
  readonly type: "content.delta";
  readonly text: string;
  readonly channel?: string;
}

export interface ActivityUpsertEventInput {
  readonly type: "activity.upsert";
  readonly activityId: string;
  readonly activity: JsonObject;
}

export interface RequestOpenedEventInput {
  readonly type: "request.opened";
  readonly requestId: string;
  readonly request: JsonObject;
}

export interface RequestResolvedEventInput {
  readonly type: "request.resolved";
  readonly requestId: string;
  readonly response?: JsonValue;
}

export interface BindingUpdatedEventInput {
  readonly type: "binding.updated";
  /** Opaque native continuation state; the runtime never exposes it publicly. */
  readonly binding: JsonValue;
}

export interface BindingUpdatedEvent {
  readonly type: "binding.updated";
}

export interface ErrorEventInput {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
  readonly details?: JsonValue;
}

export interface CustomEventInput {
  readonly type: "custom";
  /** A namespaced event name, for example `codex.item.completed`. */
  readonly name: string;
  readonly payload?: JsonValue;
}

export type HarnessEventInput =
  | SessionStateEventInput
  | TurnStateEventInput
  | ContentDeltaEventInput
  | ActivityUpsertEventInput
  | RequestOpenedEventInput
  | RequestResolvedEventInput
  | BindingUpdatedEventInput
  | ErrorEventInput
  | CustomEventInput;

export interface EventEnvelope {
  readonly protocolVersion: 1;
  readonly sequence: number;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly harnessId: string;
}

export type HarnessEvent = (
  | Exclude<HarnessEventInput, BindingUpdatedEventInput>
  | BindingUpdatedEvent
) &
  EventEnvelope;

export interface HarnessSession {
  readonly binding?: JsonValue;
  run(input: HarnessRunInput): AsyncIterable<HarnessEventInput>;
  respond?(requestId: string, response: JsonValue, signal?: AbortSignal): Promise<void> | void;
  interrupt?(signal?: AbortSignal): Promise<void> | void;
  close?(signal?: AbortSignal): Promise<void> | void;
}

export interface HarnessAdapter {
  readonly manifest: HarnessManifest;
  probe(profile: HarnessProfile, signal?: AbortSignal): Promise<ProbeResult> | ProbeResult;
  open(input: HarnessOpenInput): Promise<HarnessSession> | HarnessSession;
}

/** Alternate terminology accepted for integration authors. */
export type HarnessIntegration = HarnessAdapter;

export interface RuntimeSettings {
  readonly version: 1;
  readonly values: JsonObject;
}

export interface SessionBinding {
  readonly version: 1;
  readonly sessionId: string;
  readonly profileId: string;
  readonly harnessId: string;
  /** Adapter continuation ABI pin; currently the registered manifest version. */
  readonly adapterVersion: string;
  /** Hash of account-affecting profile fields at session creation. */
  readonly profileFingerprint: string;
  readonly cwd: string;
  readonly model?: string;
  readonly options?: JsonObject;
  readonly resume?: JsonValue;
  readonly title?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

/** Public session metadata. Native adapter continuation state is never exposed. */
export type SessionBindingView = Omit<SessionBinding, "resume">;

export type SessionSummary = SessionBindingView & {
  readonly active: boolean;
  readonly turnActive: boolean;
};

export interface StartSessionInput {
  /** Profile selection is mandatory; the runtime never silently falls back. */
  readonly profileId: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly options?: JsonObject;
  readonly signal?: AbortSignal;
}

export interface ResumeSessionInput {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface ProbeProfileOptions {
  readonly signal?: AbortSignal;
}

export interface RuntimeSession {
  readonly id: string;
  readonly binding: SessionBindingView;
  readonly turnActive: boolean;
  run(input: HarnessRunInput): AsyncIterable<HarnessEvent>;
  respond(requestId: string, response: JsonValue, signal?: AbortSignal): Promise<void>;
  interrupt(signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}

export type Clock = () => Date | number | string;
export type IdGenerator = () => string;

export interface TNanoRuntimeOptions {
  readonly dataDir: string;
  readonly registry?: import("./registry.ts").HarnessRegistry;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}
