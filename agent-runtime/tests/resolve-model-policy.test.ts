import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolvePhasePolicy,
  resolveModel,
  type ModelPolicy,
} from "../src/config/resolve-model-policy.js";
import type { ModelOverrides } from "../src/config/parse-model-overrides.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const WORKSPACE_POLICY: ModelPolicy = {
  implementation: {
    allowed: ["claude-sonnet-4-6"],
    default: "claude-sonnet-4-6",
  },
  self_review: {
    allowed: ["claude-sonnet-4-6"],
    default: "claude-sonnet-4-6",
  },
  pr_description: {
    allowed: ["claude-haiku-4-5-20251001"],
    default: "claude-haiku-4-5-20251001",
  },
  suggested_next_step: {
    allowed: ["claude-haiku-4-5-20251001"],
    default: "claude-haiku-4-5-20251001",
  },
};

const NO_OVERRIDES: ModelOverrides = {};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("resolvePhasePolicy", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // ── workspace defaults ──────────────────────────────────────────────────────

  it("returns workspace default when no task overrides", () => {
    const policy = resolvePhasePolicy(WORKSPACE_POLICY, NO_OVERRIDES, "implementation", "T3");
    expect(policy).toEqual(WORKSPACE_POLICY.implementation);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("returns workspace default for each phase when no overrides", () => {
    for (const phase of ["implementation", "self_review", "pr_description", "suggested_next_step"] as const) {
      const policy = resolvePhasePolicy(WORKSPACE_POLICY, NO_OVERRIDES, phase, "T3");
      expect(policy).toEqual(WORKSPACE_POLICY[phase]);
    }
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  // ── task overrides ──────────────────────────────────────────────────────────

  it("uses task override when provided for that phase", () => {
    const overrides: ModelOverrides = {
      implementation: {
        allowed: ["claude-opus-4-6", "claude-sonnet-4-6"],
        default: "claude-opus-4-6",
      },
    };
    const policy = resolvePhasePolicy(WORKSPACE_POLICY, overrides, "implementation", "T3");
    expect(policy.default).toBe("claude-opus-4-6");
    expect(policy.allowed).toContain("claude-opus-4-6");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("inherits workspace default for phases not in task overrides", () => {
    const overrides: ModelOverrides = {
      implementation: {
        allowed: ["claude-opus-4-6"],
        default: "claude-opus-4-6",
      },
    };
    const policy = resolvePhasePolicy(WORKSPACE_POLICY, overrides, "pr_description", "T3");
    expect(policy).toEqual(WORKSPACE_POLICY.pr_description);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("task override replaces workspace default entirely for that phase", () => {
    const overrides: ModelOverrides = {
      self_review: {
        allowed: ["claude-opus-4-6"],
        default: "claude-opus-4-6",
      },
    };
    const policy = resolvePhasePolicy(WORKSPACE_POLICY, overrides, "self_review", "T5");
    expect(policy.default).toBe("claude-opus-4-6");
    // workspace default is gone for this phase
    expect(policy.allowed).not.toContain("claude-sonnet-4-6");
  });

  // ── fallback when default not in allowed ────────────────────────────────────

  it("falls back to first allowed model when default is not in allowed list", () => {
    const badPolicy: ModelPolicy = {
      ...WORKSPACE_POLICY,
      implementation: {
        allowed: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"],
        default: "claude-opus-4-6", // not in allowed
      },
    };
    const policy = resolvePhasePolicy(badPolicy, NO_OVERRIDES, "implementation", "T3");
    expect(policy.default).toBe("claude-haiku-4-5-20251001");
    expect(consoleSpy).toHaveBeenCalledOnce();
    const event = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(event.type).toBe("model_fallback");
    expect(event.requested).toBe("claude-opus-4-6");
    expect(event.fallback).toBe("claude-haiku-4-5-20251001");
  });

  it("emits fallback event with taskId and phase", () => {
    const badPolicy: ModelPolicy = {
      ...WORKSPACE_POLICY,
      pr_description: {
        allowed: ["claude-sonnet-4-6"],
        default: "claude-opus-4-6",
      },
    };
    resolvePhasePolicy(badPolicy, NO_OVERRIDES, "pr_description", "T7");
    const event = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(event.taskId).toBe("T7");
    expect(event.phase).toBe("pr_description");
  });

  it("falls back when task override default is not in its own allowed list", () => {
    const overrides: ModelOverrides = {
      implementation: {
        allowed: ["claude-sonnet-4-6"],
        default: "claude-opus-4-6", // not in allowed
      },
    };
    const policy = resolvePhasePolicy(WORKSPACE_POLICY, overrides, "implementation", "T3");
    expect(policy.default).toBe("claude-sonnet-4-6");
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});

// ── resolveModel ──────────────────────────────────────────────────────────────

describe("resolveModel", () => {
  it("returns the default model string for the phase", () => {
    expect(resolveModel(WORKSPACE_POLICY, NO_OVERRIDES, "implementation", "T3"))
      .toBe("claude-sonnet-4-6");
    expect(resolveModel(WORKSPACE_POLICY, NO_OVERRIDES, "suggested_next_step", "T3"))
      .toBe("claude-haiku-4-5-20251001");
  });

  it("returns the task override default when set", () => {
    const overrides: ModelOverrides = {
      implementation: {
        allowed: ["claude-opus-4-6"],
        default: "claude-opus-4-6",
      },
    };
    expect(resolveModel(WORKSPACE_POLICY, overrides, "implementation", "T3"))
      .toBe("claude-opus-4-6");
  });
});
