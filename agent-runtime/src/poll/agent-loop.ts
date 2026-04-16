/**
 * Agent activation loop.
 *
 * Drives the scan → claim → run cycle on a configurable interval.
 * All real I/O (sleep, the cycle itself) is injectable so tests can run
 * synchronously with recorded side-effects.
 *
 * Behaviour controlled by idle_sleep_seconds:
 *   0   → single-shot mode: run one cycle and return.
 *         Suitable for external schedulers (K8s CronJob, systemd timer).
 *   >0  → continuous mode: run cycles indefinitely, sleeping between them.
 *         Sleep is applied after every cycle — whether the cycle ran a task
 *         or found nothing (idle).
 */

import type { AgentConfig } from "../config/validate-agent-yaml.js";

/** Result returned by one activation cycle. */
export type CycleOutcome = "ran_task" | "idle";

export interface AgentLoopOptions {
  config: AgentConfig;
  /** Execute one activation cycle. Must never throw — catch and return "idle" on error. */
  runCycle: () => Promise<CycleOutcome>;
  emit: (event: Record<string, unknown>) => void;
  /** Pause execution for ms milliseconds. Default: setTimeout-based. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the agent activation loop.
 *
 * Returns only when:
 *   - single-shot mode (idle_sleep_seconds === 0): after one cycle.
 *   - In continuous mode: never (infinite loop — caller is responsible for
 *     process lifecycle).
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { config, runCycle, emit, sleep = defaultSleep } = opts;
  const sleepMs = (config.idle_sleep_seconds ?? 60) * 1000;

  if (sleepMs === 0) {
    // Single-shot mode: one cycle, then return so main() can exit(0).
    await runCycle();
    return;
  }

  // Continuous mode: cycle indefinitely with inter-cycle sleep.
  while (true) {
    const outcome = await runCycle();

    if (outcome === "idle") {
      emit({ type: "activation_idle", sleep_ms: sleepMs });
    } else {
      emit({ type: "activation_complete", sleep_ms: sleepMs });
    }

    await sleep(sleepMs);
  }
}
