import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  mergeSessionEntry,
  snapshotSessionOrigin,
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { unbindThreadBindingsBySessionKey } from "../../discord/monitor/thread-bindings.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  readSessionMessages,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function migrateAndPruneSessionStoreKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  store: Record<string, SessionEntry>;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
  });
  const primaryKey = target.canonicalKey;
  if (!params.store[primaryKey]) {
    const existingKey = target.storeKeys.find((candidate) => Boolean(params.store[candidate]));
    if (existingKey) {
      params.store[primaryKey] = params.store[existingKey];
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  if (!params.sessionId) {
    return [];
  }
  return archiveSessionTranscripts({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
  });
}

async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  unbindThreadBindingsBySessionKey({
    targetSessionKey: params.targetSessionKey,
    targetKind,
    reason: params.reason,
    sendFarewell: true,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
}) {
  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  clearSessionQueues([...queueKeys]);
  clearBootstrapSnapshot(params.target.canonicalKey);
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    return undefined;
  }
  abortEmbeddedPiRun(params.sessionId);
  const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
  if (ended) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset" | "session-delete";
}) {
  if (!params.entry?.acp) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
      });
    },
  });
  if (cancelOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      });
    },
  });
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  return undefined;
}

async function cleanupSessionBeforeMutation(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    target: params.target,
    sessionId: params.entry?.sessionId,
  });
  if (cleanupError) {
    return cleanupError;
  }
  return await closeAcpRuntimeForSession({
    cfg: params.cfg,
    sessionKey: params.legacyKey ?? params.canonicalKey ?? params.target.canonicalKey ?? params.key,
    entry: params.entry,
    reason: params.reason,
  });
}

type GatewaySessionIdentity = {
  agent_id: string;
  session_id: string;
  session_key_source: "snapshot" | "fallback";
};

type SessionBootstrapCapabilityParams = {
  agent_id: string;
  session_identity: GatewaySessionIdentity;
};

type TranscriptReadCapabilityParams = {
  agent_id: string;
  session_identity: GatewaySessionIdentity;
  lookup_key: string;
  lookup_type: "task_id" | "context_id" | "session_id";
  limit?: number;
  cursor?: string;
};

type TranscriptEntry = {
  role: "user" | "agent" | "system" | "tool";
  text?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseGatewaySessionIdentity(value: unknown): GatewaySessionIdentity | null {
  if (!isRecord(value)) {
    return null;
  }
  const agentId = typeof value.agent_id === "string" ? value.agent_id.trim() : "";
  const sessionId = typeof value.session_id === "string" ? value.session_id.trim() : "";
  const sessionKeySource = value.session_key_source;
  if (
    !agentId ||
    !sessionId ||
    (sessionKeySource !== "snapshot" && sessionKeySource !== "fallback")
  ) {
    return null;
  }
  return {
    agent_id: agentId,
    session_id: sessionId,
    session_key_source: sessionKeySource,
  };
}

function parseSessionCapabilityParams(
  params: unknown,
  method: "sessions.bootstrap" | "presence.init",
  respond: RespondFn,
): SessionBootstrapCapabilityParams | null {
  if (!isRecord(params)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `${method} params must be an object`),
    );
    return null;
  }
  const agentId = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
  const sessionIdentity = parseGatewaySessionIdentity(params.session_identity);
  if (!agentId || !sessionIdentity) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${method} params: agent_id and session_identity are required`,
      ),
    );
    return null;
  }
  if (normalizeAgentId(agentId) !== normalizeAgentId(sessionIdentity.agent_id)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `${method} agent_id/session_identity mismatch`),
    );
    return null;
  }
  return {
    agent_id: agentId,
    session_identity: sessionIdentity,
  };
}

function parseTranscriptReadCapabilityParams(
  params: unknown,
  respond: RespondFn,
): TranscriptReadCapabilityParams | null {
  if (!isRecord(params)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "transcript.read params must be an object"),
    );
    return null;
  }
  const agentId = typeof params.agent_id === "string" ? params.agent_id.trim() : "";
  const sessionIdentity = parseGatewaySessionIdentity(params.session_identity);
  const lookupKey = typeof params.lookup_key === "string" ? params.lookup_key.trim() : "";
  const lookupType = params.lookup_type;
  const cursor = typeof params.cursor === "string" ? params.cursor.trim() : undefined;
  const limitRaw = params.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : undefined;
  if (
    !agentId ||
    !sessionIdentity ||
    !lookupKey ||
    (lookupType !== "task_id" && lookupType !== "context_id" && lookupType !== "session_id")
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "invalid transcript.read params: agent_id, session_identity, lookup_key, and lookup_type are required",
      ),
    );
    return null;
  }
  if (normalizeAgentId(agentId) !== normalizeAgentId(sessionIdentity.agent_id)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "transcript.read agent_id/session_identity mismatch"),
    );
    return null;
  }
  return {
    agent_id: agentId,
    session_identity: sessionIdentity,
    lookup_key: lookupKey,
    lookup_type: lookupType,
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function resolveRequestedSessionKey(params: {
  agentId: string;
  sessionIdentity: GatewaySessionIdentity;
  lookupKey?: string;
  lookupType?: TranscriptReadCapabilityParams["lookup_type"];
}): string {
  if (params.lookupType === "session_id" && params.lookupKey) {
    return params.lookupKey;
  }
  if (
    params.sessionIdentity.session_key_source === "snapshot" &&
    !isResolvableGatewaySessionStoreKey({
      agentId: params.agentId,
      sessionId: params.sessionIdentity.session_id,
    })
  ) {
    return buildGatewayMainSessionKey(params.agentId);
  }
  return params.sessionIdentity.session_id;
}

function buildResolvedSessionIdentity(params: {
  requested: GatewaySessionIdentity;
  canonicalKey: string;
  targetAgentId: string;
}): GatewaySessionIdentity {
  const sessionId =
    params.requested.session_key_source === "snapshot"
      ? params.requested.session_id.trim()
      : params.canonicalKey;
  return {
    agent_id: params.targetAgentId,
    session_id: sessionId,
    session_key_source: params.requested.session_key_source,
  };
}

function isResolvableGatewaySessionStoreKey(params: {
  agentId: string;
  sessionId: string;
}): boolean {
  const trimmed = params.sessionId.trim();
  if (!trimmed) {
    return false;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "global" || lowered === "unknown") {
    return true;
  }
  const cfg = loadConfig();
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  if (lowered === "main" || lowered === mainKey) {
    return true;
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return false;
  }
  return normalizeAgentId(parsed.agentId) === normalizeAgentId(params.agentId);
}

function buildGatewayMainSessionKey(agentId: string): string {
  const cfg = loadConfig();
  return buildAgentMainSessionKey({ agentId, mainKey: cfg.session?.mainKey });
}

function findSessionEntryByRuntimeSessionId(params: { agentId: string; sessionId: string }): {
  storePath: string;
  sessionFile?: string;
  canonicalKey?: string;
} | null {
  const cfg = loadConfig();
  const sessionTarget = resolveGatewaySessionStoreTarget({
    cfg,
    key: buildGatewayMainSessionKey(params.agentId),
    scanLegacyKeys: false,
  });
  const store = loadSessionStore(sessionTarget.storePath);
  const match = Object.entries(store).find(
    ([key, entry]) =>
      entry?.sessionId === params.sessionId &&
      (!parseAgentSessionKey(key) ||
        normalizeAgentId(parseAgentSessionKey(key)?.agentId) === normalizeAgentId(params.agentId)),
  );
  const canonicalKey = match
    ? resolveGatewaySessionStoreTarget({
        cfg,
        key: match[0],
        scanLegacyKeys: false,
      }).canonicalKey
    : undefined;
  const sessionFile = match?.[1]?.sessionFile;
  const transcriptExists = resolveSessionTranscriptCandidates(
    params.sessionId,
    sessionTarget.storePath,
    sessionFile,
    params.agentId,
  ).some((candidate) => fs.existsSync(candidate));
  if (!match && !transcriptExists) {
    return null;
  }
  return {
    storePath: sessionTarget.storePath,
    sessionFile,
    canonicalKey,
  };
}

async function ensureCanonicalSessionEntry(params: { key: string }): Promise<{
  cfg: ReturnType<typeof loadConfig>;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  storePath: string;
  entry: SessionEntry;
}> {
  const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(params.key);
  const entry = await updateSessionStore(storePath, (store) => {
    const resolved = resolveGatewaySessionStoreTarget({
      cfg,
      key: params.key,
      store,
    });
    pruneLegacyStoreKeys({
      store,
      canonicalKey: resolved.canonicalKey,
      candidates: resolved.storeKeys,
    });
    const merged = mergeSessionEntry(store[resolved.canonicalKey], {
      updatedAt: Date.now(),
    });
    store[resolved.canonicalKey] = merged;
    return merged;
  });
  return { cfg, target, storePath, entry };
}

function extractTranscriptText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.text !== "string") {
          return "";
        }
        return entry.text.trim();
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (isRecord(value) && typeof value.text === "string") {
    const trimmed = value.text.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function extractTranscriptTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return undefined;
}

function mapTranscriptMessageToEntry(value: unknown): TranscriptEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawRole = typeof value.role === "string" ? value.role.trim().toLowerCase() : "";
  const role =
    rawRole === "assistant"
      ? "agent"
      : rawRole === "user" || rawRole === "system" || rawRole === "tool"
        ? rawRole
        : null;
  if (!role) {
    return null;
  }
  const text = extractTranscriptText(value.content) ?? extractTranscriptText(value.text);
  const timestamp = extractTranscriptTimestamp(value.timestamp);
  const metadata = isRecord(value.__openclaw) ? value.__openclaw : undefined;
  return {
    role,
    ...(text ? { text } : {}),
    ...(metadata ? { metadata } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function paginateTranscriptEntries(params: {
  entries: TranscriptEntry[];
  limit: number;
  cursor?: string;
}): { entries: TranscriptEntry[]; cursor: string | null; has_more: boolean } | { error: string } {
  const total = params.entries.length;
  let end = total;
  if (params.cursor) {
    const parsedCursor = Number.parseInt(params.cursor, 10);
    if (!Number.isInteger(parsedCursor) || parsedCursor <= 0 || parsedCursor > total) {
      return { error: `invalid cursor: ${params.cursor}` };
    }
    end = parsedCursor;
  }
  const start = Math.max(0, end - params.limit);
  return {
    entries: params.entries.slice(start, end),
    cursor: start > 0 ? String(start) : null,
    has_more: start > 0,
  };
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.bootstrap": async ({ params, respond }) => {
    const parsed = parseSessionCapabilityParams(params, "sessions.bootstrap", respond);
    if (!parsed) {
      return;
    }
    const requestedKey = resolveRequestedSessionKey({
      agentId: parsed.agent_id,
      sessionIdentity: parsed.session_identity,
    });
    const { target } = await ensureCanonicalSessionEntry({ key: requestedKey });
    const resolvedIdentity = buildResolvedSessionIdentity({
      requested: parsed.session_identity,
      canonicalKey: target.canonicalKey,
      targetAgentId: target.agentId,
    });
    respond(
      true,
      {
        session_identity: resolvedIdentity,
        bootstrap_complete: true,
      },
      undefined,
    );
  },
  "presence.init": async ({ params, respond }) => {
    const parsed = parseSessionCapabilityParams(params, "presence.init", respond);
    if (!parsed) {
      return;
    }
    const requestedKey = resolveRequestedSessionKey({
      agentId: parsed.agent_id,
      sessionIdentity: parsed.session_identity,
    });
    const { target } = await ensureCanonicalSessionEntry({ key: requestedKey });
    const resolvedIdentity = buildResolvedSessionIdentity({
      requested: parsed.session_identity,
      canonicalKey: target.canonicalKey,
      targetAgentId: target.agentId,
    });
    // Deliberately keep presence.init as a canonical identity acknowledgment, not
    // a synthetic peer-roster write. OpenClaw does not own mesh peer topology,
    // so supporting the capability here means "the runtime accepted this session
    // identity and is ready" rather than recreating the old chat-based shim.
    respond(
      true,
      {
        peers_discovered: 0,
        session_identity: resolvedIdentity,
      },
      undefined,
    );
  },
  "transcript.read": ({ params, respond }) => {
    const parsed = parseTranscriptReadCapabilityParams(params, respond);
    if (!parsed) {
      return;
    }

    const runtimeSessionId =
      parsed.lookup_type === "session_id"
        ? parsed.lookup_key
        : parsed.session_identity.session_key_source === "snapshot" &&
            !isResolvableGatewaySessionStoreKey({
              agentId: parsed.agent_id,
              sessionId: parsed.session_identity.session_id,
            })
          ? parsed.session_identity.session_id
          : null;
    const runtimeSession = runtimeSessionId
      ? findSessionEntryByRuntimeSessionId({
          agentId: parsed.agent_id,
          sessionId: runtimeSessionId,
        })
      : null;

    let transcriptSessionId: string;
    let transcriptStorePath: string;
    let transcriptSessionFile: string | undefined;

    if (runtimeSessionId) {
      if (!runtimeSession) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${runtimeSessionId}`),
        );
        return;
      }
      transcriptSessionId = runtimeSessionId;
      transcriptStorePath = runtimeSession.storePath;
      transcriptSessionFile = runtimeSession.sessionFile;
    } else {
      const requestedKey = resolveRequestedSessionKey({
        agentId: parsed.agent_id,
        sessionIdentity: parsed.session_identity,
        lookupKey: parsed.lookup_key,
        lookupType: parsed.lookup_type,
      });
      const { target } = resolveGatewaySessionTargetFromKey(requestedKey);
      if (normalizeAgentId(parsed.agent_id) !== normalizeAgentId(target.agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `agent not found: ${parsed.agent_id}`),
        );
        return;
      }

      const { entry } = loadSessionEntry(target.canonicalKey);
      if (!entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${target.canonicalKey}`),
        );
        return;
      }
      transcriptSessionId = entry.sessionId;
      transcriptStorePath = target.storePath;
      transcriptSessionFile = entry.sessionFile;
    }

    const mappedEntries = readSessionMessages(
      transcriptSessionId,
      transcriptStorePath,
      transcriptSessionFile,
    )
      .map(mapTranscriptMessageToEntry)
      .filter((value): value is TranscriptEntry => value !== null);
    const page = paginateTranscriptEntries({
      entries: mappedEntries,
      limit: parsed.limit ?? 50,
      cursor: parsed.cursor,
    });
    if ("error" in page) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, page.error));
      return;
    }

    respond(
      true,
      {
        entries: page.entries,
        cursor: page.cursor,
        has_more: page.has_more,
      },
      undefined,
    );
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const hadExistingEntry = Boolean(entry);
    const commandReason = p.reason === "new" ? "new" : "reset";
    const hookEvent = createInternalHookEvent(
      "command",
      commandReason,
      target.canonicalKey ?? key,
      {
        sessionEntry: entry,
        previousSessionEntry: entry,
        commandSource: "gateway:sessions.reset",
        cfg,
      },
    );
    await triggerInternalHook(hookEvent);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-reset",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    let oldSessionId: string | undefined;
    let oldSessionFile: string | undefined;
    const next = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const entry = store[primaryKey];
      const parsed = parseAgentSessionKey(primaryKey);
      const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
      const resolvedModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
      oldSessionId = entry?.sessionId;
      oldSessionFile = entry?.sessionFile;
      const now = Date.now();
      const nextEntry: SessionEntry = {
        sessionId: randomUUID(),
        updatedAt: now,
        systemSent: false,
        abortedLastRun: false,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        responseUsage: entry?.responseUsage,
        model: resolvedModel.model,
        modelProvider: resolvedModel.provider,
        contextTokens: entry?.contextTokens,
        sendPolicy: entry?.sendPolicy,
        label: entry?.label,
        origin: snapshotSessionOrigin(entry),
        lastChannel: entry?.lastChannel,
        lastTo: entry?.lastTo,
        skillsSnapshot: entry?.skillsSnapshot,
        // Reset token counts to 0 on session reset (#1523)
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalTokensFresh: true,
      };
      store[primaryKey] = nextEntry;
      return nextEntry;
    });
    // Archive old transcript so it doesn't accumulate on disk (#14869).
    archiveSessionTranscriptsForSession({
      sessionId: oldSessionId,
      storePath,
      sessionFile: oldSessionFile,
      agentId: target.agentId,
      reason: "reset",
    });
    if (hadExistingEntry) {
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-reset",
      });
    }
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archived =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSession({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    if (deleted) {
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
  },
};
