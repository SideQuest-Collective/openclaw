import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import qrcode from "qrcode-terminal";
import { formatCliCommand } from "../cli/command-format.js";
import { danger, success } from "../globals.js";
import { getChildLogger, toPinoLikeLogger } from "../logging.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { VERSION } from "../version.js";
import {
  maybeRestoreCredsFromBackup,
  readCredsJsonRaw,
  resolveDefaultWebAuthDir,
  resolveWebCredsBackupPath,
  resolveWebCredsPath,
} from "./auth-store.js";

export {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  readWebSelfId,
  WA_WEB_AUTH_DIR,
  webAuthExists,
} from "./auth-store.js";

let credsSaveQueue: Promise<void> = Promise.resolve();
type BaileysVersion = Awaited<ReturnType<typeof fetchLatestBaileysVersion>>["version"];
const BAILEYS_VERSION_FETCH_TIMEOUT_MS = 5_000;
const BAILEYS_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cachedBaileysVersion: BaileysVersion | null = null;
let cachedBaileysVersionAt = 0;

export function resetBaileysVersionCacheForTests() {
  cachedBaileysVersion = null;
  cachedBaileysVersionAt = 0;
}

function getCachedBaileysVersion(now = Date.now()): BaileysVersion | null {
  if (!cachedBaileysVersion) {
    return null;
  }
  if (now - cachedBaileysVersionAt > BAILEYS_VERSION_CACHE_TTL_MS) {
    return null;
  }
  return cachedBaileysVersion;
}

async function fetchLatestBaileysVersionWithTimeout(timeoutMs: number): Promise<BaileysVersion> {
  return await new Promise<BaileysVersion>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const timeoutError = Object.assign(
        new Error(`Timed out fetching Baileys version after ${timeoutMs}ms`),
        {
          status: 408,
          code: "WA_VERSION_FETCH_TIMEOUT",
        },
      );
      reject(timeoutError);
    }, timeoutMs);

    void fetchLatestBaileysVersion()
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result.version);
      })
      .catch((err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function resolveBaileysVersion(logger: ReturnType<typeof getChildLogger>) {
  const cached = getCachedBaileysVersion();
  if (cached) {
    return cached;
  }
  try {
    const version = await fetchLatestBaileysVersionWithTimeout(BAILEYS_VERSION_FETCH_TIMEOUT_MS);
    cachedBaileysVersion = version;
    cachedBaileysVersionAt = Date.now();
    return version;
  } catch (err) {
    if (cachedBaileysVersion) {
      logger.warn(
        { error: String(err) },
        "Baileys version fetch failed; using last known cached version",
      );
      return cachedBaileysVersion;
    }
    logger.warn({ error: String(err) }, "Baileys version fetch failed; using library default");
    return undefined;
  }
}

function enqueueSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): void {
  credsSaveQueue = credsSaveQueue
    .then(() => safeSaveCreds(authDir, saveCreds, logger))
    .catch((err) => {
      logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
    });
}

async function safeSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): Promise<void> {
  try {
    // Best-effort backup so we can recover after abrupt restarts.
    // Important: don't clobber a good backup with a corrupted/truncated creds.json.
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      try {
        JSON.parse(raw);
        fsSync.copyFileSync(credsPath, backupPath);
        try {
          fsSync.chmodSync(backupPath, 0o600);
        } catch {
          // best-effort on platforms that support it
        }
      } catch {
        // keep existing backup
      }
    }
  } catch {
    // ignore backup failures
  }
  try {
    await Promise.resolve(saveCreds());
    try {
      fsSync.chmodSync(resolveWebCredsPath(authDir), 0o600);
    } catch {
      // best-effort on platforms that support it
    }
  } catch (err) {
    logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
  }
}

/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export async function createWaSocket(
  printQr: boolean,
  verbose: boolean,
  opts: { authDir?: string; onQr?: (qr: string) => void } = {},
): Promise<ReturnType<typeof makeWASocket>> {
  const baseLogger = getChildLogger(
    { module: "baileys" },
    {
      level: verbose ? "info" : "silent",
    },
  );
  const logger = toPinoLikeLogger(baseLogger, verbose ? "info" : "silent");
  const authDir = resolveUserPath(opts.authDir ?? resolveDefaultWebAuthDir());
  await ensureDir(authDir);
  const sessionLogger = getChildLogger({ module: "web-session" });
  maybeRestoreCredsFromBackup(authDir);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await resolveBaileysVersion(sessionLogger);
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    ...(version ? { version } : {}),
    logger,
    printQRInTerminal: false,
    browser: ["openclaw", "cli", VERSION],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, sessionLogger));
  sock.ev.on(
    "connection.update",
    (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          opts.onQr?.(qr);
          if (printQr) {
            console.log("Scan this QR in WhatsApp (Linked Devices):");
            qrcode.generate(qr, { small: true });
          }
        }
        if (connection === "close") {
          const status = getStatusCode(lastDisconnect?.error);
          if (status === DisconnectReason.loggedOut) {
            console.error(
              danger(
                `WhatsApp session logged out. Run: ${formatCliCommand("openclaw channels login")}`,
              ),
            );
          }
        }
        if (connection === "open" && verbose) {
          console.log(success("WhatsApp Web connected."));
        }
      } catch (err) {
        sessionLogger.error({ error: String(err) }, "connection.update handler error");
      }
    },
  );

  // Handle WebSocket-level errors to prevent unhandled exceptions from crashing the process
  if (sock.ws && typeof (sock.ws as unknown as { on?: unknown }).on === "function") {
    sock.ws.on("error", (err: Error) => {
      sessionLogger.error({ error: String(err) }, "WebSocket error");
    });
  }

  return sock;
}

export async function waitForWaConnection(
  sock: ReturnType<typeof makeWASocket>,
  opts: { timeoutMs?: number } = {},
) {
  return new Promise<void>((resolve, reject) => {
    type OffCapable = {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const evWithOff = sock.ev as unknown as OffCapable;
    const timeoutMs =
      typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const detach = () => {
      if (typeof evWithOff.off === "function") {
        evWithOff.off("connection.update", handler);
      } else if (typeof evWithOff.removeListener === "function") {
        evWithOff.removeListener("connection.update", handler);
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const handler = (...args: unknown[]) => {
      const update = (args[0] ?? {}) as Partial<import("@whiskeysockets/baileys").ConnectionState>;
      if (update.connection === "open") {
        detach();
        resolve();
      }
      if (update.connection === "close") {
        detach();
        reject(update.lastDisconnect ?? new Error("Connection closed"));
      }
    };

    sock.ev.on("connection.update", handler);

    if (timeoutMs) {
      timeoutHandle = setTimeout(() => {
        detach();
        const timeoutError = Object.assign(
          new Error(`Timed out waiting for WhatsApp connection after ${timeoutMs}ms`),
          {
            status: 408,
            code: "WA_CONNECT_TIMEOUT",
          },
        );
        reject(timeoutError);
      }, timeoutMs);
    }
  });
}

export function getStatusCode(err: unknown) {
  return (
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status
  );
}

function safeStringify(value: unknown, limit = 800): string {
  try {
    const seen = new WeakSet();
    const raw = JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "bigint") {
          return v.toString();
        }
        if (typeof v === "function") {
          const maybeName = (v as { name?: unknown }).name;
          const name =
            typeof maybeName === "string" && maybeName.length > 0 ? maybeName : "anonymous";
          return `[Function ${name}]`;
        }
        if (typeof v === "object" && v) {
          if (seen.has(v)) {
            return "[Circular]";
          }
          seen.add(v);
        }
        return v;
      },
      2,
    );
    if (!raw) {
      return String(value);
    }
    return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
  } catch {
    return String(value);
  }
}

function extractBoomDetails(err: unknown): {
  statusCode?: number;
  error?: string;
  message?: string;
} | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const output = (err as { output?: unknown })?.output as
    | { statusCode?: unknown; payload?: unknown }
    | undefined;
  if (!output || typeof output !== "object") {
    return null;
  }
  const payload = (output as { payload?: unknown }).payload as
    | { error?: unknown; message?: unknown; statusCode?: unknown }
    | undefined;
  const statusCode =
    typeof (output as { statusCode?: unknown }).statusCode === "number"
      ? ((output as { statusCode?: unknown }).statusCode as number)
      : typeof payload?.statusCode === "number"
        ? payload.statusCode
        : undefined;
  const error = typeof payload?.error === "string" ? payload.error : undefined;
  const message = typeof payload?.message === "string" ? payload.message : undefined;
  if (!statusCode && !error && !message) {
    return null;
  }
  return { statusCode, error, message };
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (!err || typeof err !== "object") {
    return String(err);
  }

  // Baileys frequently wraps errors under `error` with a Boom-like shape.
  const boom =
    extractBoomDetails(err) ??
    extractBoomDetails((err as { error?: unknown })?.error) ??
    extractBoomDetails((err as { lastDisconnect?: { error?: unknown } })?.lastDisconnect?.error);

  const status = boom?.statusCode ?? getStatusCode(err);
  const code = (err as { code?: unknown })?.code;
  const codeText = typeof code === "string" || typeof code === "number" ? String(code) : undefined;

  const messageCandidates = [
    boom?.message,
    typeof (err as { message?: unknown })?.message === "string"
      ? ((err as { message?: unknown }).message as string)
      : undefined,
    typeof (err as { error?: { message?: unknown } })?.error?.message === "string"
      ? ((err as { error?: { message?: unknown } }).error?.message as string)
      : undefined,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));
  const message = messageCandidates[0];

  const pieces: string[] = [];
  if (typeof status === "number") {
    pieces.push(`status=${status}`);
  }
  if (boom?.error) {
    pieces.push(boom.error);
  }
  if (message) {
    pieces.push(message);
  }
  if (codeText) {
    pieces.push(`code=${codeText}`);
  }

  if (pieces.length > 0) {
    return pieces.join(" ");
  }
  return safeStringify(err);
}

export function newConnectionId() {
  return randomUUID();
}
