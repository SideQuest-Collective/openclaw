import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { runNonInteractiveOnboardingLocal } from "./onboard-non-interactive/local.js";
import { runNonInteractiveOnboardingRemote } from "./onboard-non-interactive/remote.js";
import type { OnboardOptions } from "./onboard-types.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    reason.name = "AbortError";
    throw reason;
  }
  const error = new Error(
    typeof reason === "string" && reason.trim() ? reason.trim() : "Onboarding aborted.",
  );
  error.name = "AbortError";
  throw error;
}

export async function runNonInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  throwIfAborted(opts.abortSignal);
  const snapshot = await readConfigFileSnapshot();
  throwIfAborted(opts.abortSignal);
  if (snapshot.exists && !snapshot.valid) {
    runtime.error(
      `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run onboarding.`,
    );
    runtime.exit(1);
    return;
  }

  const baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};
  const mode = opts.mode ?? "local";
  if (mode !== "local" && mode !== "remote") {
    runtime.error(`Invalid --mode "${String(mode)}" (use local|remote).`);
    runtime.exit(1);
    return;
  }

  if (mode === "remote") {
    throwIfAborted(opts.abortSignal);
    await runNonInteractiveOnboardingRemote({ opts, runtime, baseConfig });
    return;
  }

  throwIfAborted(opts.abortSignal);
  await runNonInteractiveOnboardingLocal({ opts, runtime, baseConfig });
}
