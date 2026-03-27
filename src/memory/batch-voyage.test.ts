import { ReadableStream } from "node:stream/web";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VoyageBatchOutputLine, VoyageBatchRequest } from "./batch-voyage.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
import { withRemoteHttpResponse } from "./remote-http.js";

// Mock internal.js if needed, but runWithConcurrency is simple enough to keep real.
// We DO need to mock retryAsync to avoid actual delays/retries logic complicating tests
vi.mock("../infra/retry.js", () => ({
  retryAsync: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("./remote-http.js", async () => {
  const actual = await vi.importActual<typeof import("./remote-http.js")>("./remote-http.js");
  return {
    ...actual,
    withRemoteHttpResponse: vi.fn(),
  };
});

const withRemoteHttpResponseMock = vi.mocked(withRemoteHttpResponse);

describe("runVoyageEmbeddingBatches", () => {
  let runVoyageEmbeddingBatches: typeof import("./batch-voyage.js").runVoyageEmbeddingBatches;

  beforeAll(async () => {
    ({ runVoyageEmbeddingBatches } = await import("./batch-voyage.js"));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const mockClient: VoyageEmbeddingClient = {
    baseUrl: "https://api.voyageai.com/v1",
    headers: { Authorization: "Bearer test-key" },
    model: "voyage-4-large",
  };

  const mockRequests: VoyageBatchRequest[] = [
    { custom_id: "req-1", body: { input: "text1" } },
    { custom_id: "req-2", body: { input: "text2" } },
  ];

  it("successfully submits batch, waits, and streams results", async () => {
    const outputLines: VoyageBatchOutputLine[] = [
      {
        custom_id: "req-1",
        response: { status_code: 200, body: { data: [{ embedding: [0.1, 0.1] }] } },
      },
      {
        custom_id: "req-2",
        response: { status_code: 200, body: { data: [{ embedding: [0.2, 0.2] }] } },
      },
    ];

    // Create a stream that emits the NDJSON lines
    const stream = new ReadableStream({
      start(controller) {
        const text = outputLines.map((l) => JSON.stringify(l)).join("\n");
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    withRemoteHttpResponseMock.mockImplementation(async (params) => {
      if (params.url.endsWith("/files")) {
        return await params.onResponse(
          new Response(JSON.stringify({ id: "file-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (params.url.endsWith("/batches")) {
        return await params.onResponse(
          new Response(JSON.stringify({ id: "batch-abc", status: "pending" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (params.url.endsWith("/batches/batch-abc")) {
        return await params.onResponse(
          new Response(
            JSON.stringify({
              id: "batch-abc",
              status: "completed",
              output_file_id: "file-out-999",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (params.url.endsWith("/files/file-out-999/content")) {
        return await params.onResponse(new Response(stream, { status: 200 }));
      }
      throw new Error(`unexpected remote http ${params.url}`);
    });

    const results = await runVoyageEmbeddingBatches({
      client: mockClient,
      agentId: "agent-1",
      requests: mockRequests,
      wait: true,
      pollIntervalMs: 1, // fast poll
      timeoutMs: 1000,
      concurrency: 1,
    });

    expect(results.size).toBe(2);
    expect(results.get("req-1")).toEqual([0.1, 0.1]);
    expect(results.get("req-2")).toEqual([0.2, 0.2]);

    // Verify calls
    expect(withRemoteHttpResponseMock).toHaveBeenCalledTimes(4);

    // Verify File Upload
    expect(withRemoteHttpResponseMock.mock.calls[0]?.[0]?.url).toContain("/files");
    const uploadBody = withRemoteHttpResponseMock.mock.calls[0]?.[0]?.init?.body as FormData;
    expect(uploadBody).toBeInstanceOf(FormData);
    expect(uploadBody.get("purpose")).toBe("batch");

    // Verify Batch Create
    expect(withRemoteHttpResponseMock.mock.calls[1]?.[0]?.url).toContain("/batches");
    const createBodyRaw = withRemoteHttpResponseMock.mock.calls[1]?.[0]?.init?.body;
    expect(typeof createBodyRaw).toBe("string");
    const createBody = JSON.parse((createBodyRaw as string | undefined) ?? "{}");
    expect(createBody.input_file_id).toBe("file-123");
    expect(createBody.completion_window).toBe("12h");
    expect(createBody.request_params).toEqual({
      model: "voyage-4-large",
      input_type: "document",
    });

    // Verify Content Fetch
    expect(withRemoteHttpResponseMock.mock.calls[3]?.[0]?.url).toContain(
      "/files/file-out-999/content",
    );
  });

  it("handles empty lines and stream chunks correctly", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const line1 = JSON.stringify({
          custom_id: "req-1",
          response: { body: { data: [{ embedding: [1] }] } },
        });
        const line2 = JSON.stringify({
          custom_id: "req-2",
          response: { body: { data: [{ embedding: [2] }] } },
        });

        // Split across chunks
        controller.enqueue(new TextEncoder().encode(line1 + "\n"));
        controller.enqueue(new TextEncoder().encode("\n")); // empty line
        controller.enqueue(new TextEncoder().encode(line2)); // no newline at EOF
        controller.close();
      },
    });
    withRemoteHttpResponseMock.mockImplementation(async (params) => {
      if (params.url.endsWith("/files")) {
        return await params.onResponse(
          new Response(JSON.stringify({ id: "f1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (params.url.endsWith("/batches")) {
        return await params.onResponse(
          new Response(JSON.stringify({ id: "b1", status: "completed", output_file_id: "out1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (params.url.endsWith("/files/out1/content")) {
        return await params.onResponse(new Response(stream, { status: 200 }));
      }
      throw new Error(`unexpected remote http ${params.url}`);
    });

    const results = await runVoyageEmbeddingBatches({
      client: mockClient,
      agentId: "a1",
      requests: mockRequests,
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
      concurrency: 1,
    });

    expect(results.get("req-1")).toEqual([1]);
    expect(results.get("req-2")).toEqual([2]);
  });
});
