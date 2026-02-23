import { afterEach, expect, test } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";

const HOLD_COMMAND = 'node -e "setTimeout(() => {}, 30000)"';
const TEST_EXEC_DEFAULTS = {
  security: "full" as const,
  ask: "off" as const,
  allowBackground: true,
  backgroundMs: 0,
};

afterEach(() => {
  resetProcessRegistryForTests();
});

async function startBackgroundSession(tool: ReturnType<typeof createExecTool>): Promise<string> {
  const result = await tool.execute("toolcall", { command: HOLD_COMMAND, background: true });
  expect(result.details.status).toBe("running");
  return (result.details as { sessionId: string }).sessionId;
}

async function killSession(tool: ReturnType<typeof createProcessTool>, sessionId: string) {
  await tool.execute("toolcall", { action: "kill", sessionId });
}

test("enforces maxBackgroundSessionsPerAgent per scope", async () => {
  const scopeKey = "agent:alpha";
  const execTool = createExecTool({
    ...TEST_EXEC_DEFAULTS,
    scopeKey,
    maxBackgroundSessionsPerAgent: 1,
  });
  const processTool = createProcessTool({ scopeKey });

  const sessionId = await startBackgroundSession(execTool);
  try {
    await expect(
      execTool.execute("toolcall", { command: HOLD_COMMAND, background: true }),
    ).rejects.toThrow(/Background session limit reached/i);
  } finally {
    await killSession(processTool, sessionId);
  }
});

test("applies background limit independently per scope", async () => {
  const scopeA = "agent:alpha";
  const scopeB = "agent:beta";
  const execA = createExecTool({
    ...TEST_EXEC_DEFAULTS,
    scopeKey: scopeA,
    maxBackgroundSessionsPerAgent: 1,
  });
  const execB = createExecTool({
    ...TEST_EXEC_DEFAULTS,
    scopeKey: scopeB,
    maxBackgroundSessionsPerAgent: 1,
  });
  const processA = createProcessTool({ scopeKey: scopeA });
  const processB = createProcessTool({ scopeKey: scopeB });

  const sessionA = await startBackgroundSession(execA);
  const sessionB = await startBackgroundSession(execB);
  try {
    expect(sessionA).not.toBe(sessionB);
  } finally {
    await killSession(processA, sessionA);
    await killSession(processB, sessionB);
  }
});
