export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface HarnessSummary {
  id: string;
  label?: string;
  version?: string;
  description?: string;
  capabilities?: readonly string[];
  [key: string]: unknown;
}

export interface ProfileSummary {
  id: string;
  harnessId: string;
  label?: string;
  model?: string;
  status?: string;
  [key: string]: unknown;
}

export interface SessionSummary {
  id: string;
  profileId: string;
  cwd: string;
  model?: string;
  state?: string;
  [key: string]: unknown;
}

export interface RuntimeEvent {
  kind: string;
  sessionId?: string;
  turnId?: string;
  sequence?: number;
  timestamp?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface StartSessionInput {
  profileId: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  resumeSessionId?: string;
}

export interface SendInput {
  sessionId: string;
  prompt: string;
}

export interface SendResult {
  sessionId: string;
  turnId?: string;
  text?: string;
  [key: string]: unknown;
}

export interface AddProfileInput {
  id: string;
  harnessId: string;
  label?: string;
  config: Record<string, unknown>;
}

export type EventListener = (event: RuntimeEvent) => void;

/**
 * The exact SDK surface consumed by the CLI. `sdkBridge.ts` is the only place
 * that adapts the public SDK to this presentation-oriented port.
 */
export interface RuntimePort {
  initialize(): Promise<unknown>;
  shutdown(): Promise<void>;
  listHarnesses(): Promise<readonly HarnessSummary[]>;
  listProfiles(): Promise<readonly ProfileSummary[]>;
  addProfile(input: AddProfileInput): Promise<ProfileSummary>;
  removeProfile(id: string): Promise<void>;
  probeProfile(id: string): Promise<unknown>;
  listSessions(): Promise<readonly SessionSummary[]>;
  startSession(input: StartSessionInput): Promise<SessionSummary>;
  send(input: SendInput): Promise<SendResult>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  respond(sessionId: string, requestId: string, response: unknown): Promise<void>;
  subscribe(listener: EventListener): () => void;
}
