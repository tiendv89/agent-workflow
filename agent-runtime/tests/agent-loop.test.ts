/**
 * Tests for poll/agent-loop.ts
 *
 * Covers:
 *   - single-shot mode (idle_sleep_seconds === 0): runs exactly one cycle, no sleep
 *   - continuous mode (idle_sleep_seconds > 0): cycles with sleep between each
 *   - idle cycle emits activation_idle with sleep_ms
 *   - ran_task cycle emits activation_complete with sleep_ms
 *   - post-task sleep: sleep is applied after a successful task run (same as idle sleep)
 *   - injectable sleep: tests run synchronously by resolving immediately
 */

import { describe, it, expect } from "vitest";
import { runAgentLoop, type CycleOutcome } from "../src/poll/agent-loop.js";
import type { AgentConfig } from "../src/config/validate-agent-yaml.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(idle_sleep_seconds: number | undefined): AgentConfig {
  return {
    watches: ["git@github.com:org/workspace.git"],
    enabled: true,
    jitter_max_seconds: 0,
    budget: { max_tokens_per_task: 1000, max_iterations: 5 },
    log_sink: { enabled: false },
    idle_sleep_seconds,
  };
}

function makeImmediateSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
    calls,
  };
}

function makeLimitedCycle(
  outcomes: CycleOutcome[],
  onExhausted?: () => never,
): { runCycle: () => Promise<CycleOutcome>; callCount: number } {
  let callCount = 0;
  const state = { callCount };
  return {
    runCycle: async () => {
      state.callCount++;
      callCount = state.callCount;
      const outcome = outcomes[callCount - 1];
      if (outcome === undefined) {
        if (onExhausted) onExhausted();
        throw new Error("runCycle called more times than expected");
      }
      return outcome;
    },
    get callCount() {
      return callCount;
    },
  };
}

// ── Single-shot mode ──────────────────────────────────────────────────────────

describe("runAgentLoop — single-shot mode (idle_sleep_seconds === 0)", () => {
  it("runs exactly one cycle and returns without sleeping", async () => {
    const config = makeConfig(0);
    const { sleep, calls } = makeImmediateSleep();
    let cycleCount = 0;

    await runAgentLoop({
      config,
      runCycle: async () => { cycleCount++; return "idle"; },
      emit: () => {},
      sleep,
    });

    expect(cycleCount).toBe(1);
    expect(calls).toHaveLength(0); // no sleep in single-shot mode
  });

  it("runs exactly one cycle even when cycle returns ran_task", async () => {
    const config = makeConfig(0);
    const { sleep, calls } = makeImmediateSleep();
    let cycleCount = 0;

    await runAgentLoop({
      config,
      runCycle: async () => { cycleCount++; return "ran_task"; },
      emit: () => {},
      sleep,
    });

    expect(cycleCount).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("does not emit activation_idle or activation_complete in single-shot mode", async () => {
    const config = makeConfig(0);
    const events: Record<string, unknown>[] = [];

    await runAgentLoop({
      config,
      runCycle: async () => "idle",
      emit: (e) => events.push(e),
      sleep: async () => {},
    });

    const types = events.map((e) => e["type"]);
    expect(types).not.toContain("activation_idle");
    expect(types).not.toContain("activation_complete");
  });
});

// ── Continuous mode ───────────────────────────────────────────────────────────

describe("runAgentLoop — continuous mode (idle_sleep_seconds > 0)", () => {
  it("sleeps after an idle cycle", async () => {
    const config = makeConfig(30); // 30s → 30000ms
    const { sleep, calls } = makeImmediateSleep();
    let cycleCount = 0;

    // Run 3 cycles then abort by throwing to break the while(true) loop.
    await expect(
      runAgentLoop({
        config,
        runCycle: async () => {
          cycleCount++;
          if (cycleCount >= 3) throw new Error("stop");
          return "idle";
        },
        emit: () => {},
        sleep,
      }),
    ).rejects.toThrow("stop");

    // Sleep should have been called twice (after cycle 1 and cycle 2).
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(30_000);
    expect(calls[1]).toBe(30_000);
  });

  it("sleeps after a ran_task cycle (post-task sleep)", async () => {
    const config = makeConfig(60); // 60s → 60000ms
    const { sleep, calls } = makeImmediateSleep();
    let cycleCount = 0;

    await expect(
      runAgentLoop({
        config,
        runCycle: async () => {
          cycleCount++;
          if (cycleCount >= 2) throw new Error("stop");
          return "ran_task";
        },
        emit: () => {},
        sleep,
      }),
    ).rejects.toThrow("stop");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(60_000);
  });

  it("emits activation_idle when cycle returns idle", async () => {
    const config = makeConfig(10);
    const events: Record<string, unknown>[] = [];
    let cycleCount = 0;

    await expect(
      runAgentLoop({
        config,
        runCycle: async () => {
          cycleCount++;
          if (cycleCount >= 2) throw new Error("stop");
          return "idle";
        },
        emit: (e) => events.push(e),
        sleep: async () => {},
      }),
    ).rejects.toThrow("stop");

    const idleEvent = events.find((e) => e["type"] === "activation_idle");
    expect(idleEvent).toBeDefined();
    expect(idleEvent!["sleep_ms"]).toBe(10_000);
  });

  it("emits activation_complete when cycle returns ran_task", async () => {
    const config = makeConfig(10);
    const events: Record<string, unknown>[] = [];
    let cycleCount = 0;

    await expect(
      runAgentLoop({
        config,
        runCycle: async () => {
          cycleCount++;
          if (cycleCount >= 2) throw new Error("stop");
          return "ran_task";
        },
        emit: (e) => events.push(e),
        sleep: async () => {},
      }),
    ).rejects.toThrow("stop");

    const doneEvent = events.find((e) => e["type"] === "activation_complete");
    expect(doneEvent).toBeDefined();
    expect(doneEvent!["sleep_ms"]).toBe(10_000);
  });

  it("uses 60s default when idle_sleep_seconds is undefined", async () => {
    const config = makeConfig(undefined); // should default to 60
    const { sleep, calls } = makeImmediateSleep();
    let cycleCount = 0;

    await expect(
      runAgentLoop({
        config,
        runCycle: async () => {
          cycleCount++;
          if (cycleCount >= 2) throw new Error("stop");
          return "idle";
        },
        emit: () => {},
        sleep,
      }),
    ).rejects.toThrow("stop");

    expect(calls[0]).toBe(60_000);
  });

  it("alternates idle and ran_task outcomes correctly", async () => {
    const config = makeConfig(5);
    const events: Record<string, unknown>[] = [];
    const outcomes: CycleOutcome[] = ["idle", "ran_task", "idle"];
    let idx = 0;

    await expect(
      runAgentLoop({
        config,
        runCycle: async () => {
          const outcome = outcomes[idx++];
          if (outcome === undefined) throw new Error("stop");
          return outcome;
        },
        emit: (e) => events.push(e),
        sleep: async () => {},
      }),
    ).rejects.toThrow("stop");

    const types = events.map((e) => e["type"]);
    expect(types).toEqual(["activation_idle", "activation_complete", "activation_idle"]);
  });
});
