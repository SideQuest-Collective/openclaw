import fs from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFileWithinRoot: vi.fn(),
  cleanOldMedia: vi.fn().mockResolvedValue(undefined),
}));

let mediaDir = "";

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    readFileWithinRoot: mocks.readFileWithinRoot,
  };
});

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    getMediaDir: () => mediaDir,
    cleanOldMedia: mocks.cleanOldMedia,
  };
});

const { SafeOpenError } = await import("../infra/fs-safe.js");
const { startMediaServer } = await import("./server.js");

function isBindPermissionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    ((err as NodeJS.ErrnoException).code === "EPERM" ||
      (err as NodeJS.ErrnoException).code === "EACCES")
  );
}

async function canBindLoopbackInThisEnvironment(): Promise<boolean> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return true;
  } catch (err) {
    if (isBindPermissionError(err)) {
      return false;
    }
    throw err;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }
}

const describeMediaOutsideWorkspace = (await canBindLoopbackInThisEnvironment())
  ? describe
  : describe.skip;

describeMediaOutsideWorkspace("media server outside-workspace mapping", () => {
  let server: Awaited<ReturnType<typeof startMediaServer>> | null = null;
  let port = 0;

  beforeAll(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-outside-workspace-"));
    server = await startMediaServer(0, 1_000);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server?.close(resolve));
    }
    await fs.rm(mediaDir, { recursive: true, force: true });
    mediaDir = "";
  });

  it("returns 400 with a specific outside-workspace message", async () => {
    mocks.readFileWithinRoot.mockRejectedValueOnce(
      new SafeOpenError("outside-workspace", "file is outside workspace root"),
    );

    const response = await fetch(`http://127.0.0.1:${port}/media/ok-id`);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("file is outside workspace root");
  });
});
