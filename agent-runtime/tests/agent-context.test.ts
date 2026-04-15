/**
 * Tests for agent-context.ts — generateAgentContext (T4).
 *
 * Test plan:
 *   1. All opts fields appear in the returned string in the appropriate sections.
 *   2. The string never contains the literal text "undefined" or "null".
 *   3. Required section headers are present.
 *   4. Execution sequence mentions /start-implementation, /pr-self-review, /pr-create.
 */

import { describe, it, expect } from "vitest";
import {
  generateAgentContext,
  type AgentContextOpts,
} from "../src/bootstrap/agent-context.js";

const BASE_OPTS: AgentContextOpts = {
  taskId: "T4",
  featureId: "agent-runtime-hardening",
  taskTitle: "Agent context generator — src/bootstrap/agent-context.ts",
  taskBranch: "feature/agent-runtime-hardening-T4",
  taskRepo: "workflow",
  taskRepoRoot: "/home/agent/data/workflow",
  workspaceRoot: "/home/agent/data/workspace",
  gitAuthorEmail: "agent@example.com",
  gitAuthorName: "Agent Bot",
  implementationModel: "claude-opus-4-6",
};

describe("generateAgentContext", () => {
  it("returns a string", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains taskId in the output", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain(BASE_OPTS.taskId);
  });

  it("contains featureId in the output", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain(BASE_OPTS.featureId);
  });

  it("contains taskBranch in the output", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain(BASE_OPTS.taskBranch);
  });

  it("contains workspaceRoot in the output", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain(BASE_OPTS.workspaceRoot);
  });

  it("contains gitAuthorEmail in the output", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain(BASE_OPTS.gitAuthorEmail);
  });

  it("contains gitAuthorName in the output", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain(BASE_OPTS.gitAuthorName);
  });

  it("contains implementationModel in the output", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain(BASE_OPTS.implementationModel);
  });

  it("does not contain the literal text 'undefined'", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).not.toContain("undefined");
  });

  it("does not contain the literal text 'null'", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).not.toContain("null");
  });

  it("includes the ## Identity section", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("## Identity");
  });

  it("includes the ## Your claimed task section", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("## Your claimed task");
  });

  it("includes the ## What you must do section", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("## What you must do");
  });

  it("includes the ## Model section", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("## Model");
  });

  it("includes the ## Rules section", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("## Rules");
  });

  it("mentions /start-implementation in the execution sequence", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("/start-implementation");
  });

  it("mentions /pr-self-review in the execution sequence", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("/pr-self-review");
  });

  it("mentions /pr-create in the execution sequence", () => {
    const result = generateAgentContext(BASE_OPTS);
    expect(result).toContain("/pr-create");
  });

  it("requires running the test suite before /pr-create", () => {
    const result = generateAgentContext(BASE_OPTS);
    // Both test commands must be mentioned
    expect(result).toContain("npx vitest run");
    expect(result).toContain("tsc --noEmit");
    // Test step must appear before /pr-create
    const testIdx = result.indexOf("npx vitest run");
    const prCreateIdx = result.indexOf("/pr-create");
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeLessThan(prCreateIdx);
  });

  it("places implementationModel under the ## Model section", () => {
    const result = generateAgentContext(BASE_OPTS);
    const modelIdx = result.indexOf("## Model");
    const modelValueIdx = result.indexOf(BASE_OPTS.implementationModel);
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelValueIdx).toBeGreaterThan(modelIdx);
  });

  it("places gitAuthorEmail under the ## Identity section", () => {
    const result = generateAgentContext(BASE_OPTS);
    const identityIdx = result.indexOf("## Identity");
    const emailIdx = result.indexOf(BASE_OPTS.gitAuthorEmail);
    const nextSectionIdx = result.indexOf("##", identityIdx + 1);
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(emailIdx).toBeGreaterThan(identityIdx);
    expect(emailIdx).toBeLessThan(nextSectionIdx);
  });

  it("produces different outputs for different taskIds", () => {
    const result1 = generateAgentContext(BASE_OPTS);
    const result2 = generateAgentContext({ ...BASE_OPTS, taskId: "T99" });
    expect(result1).not.toBe(result2);
    expect(result2).toContain("T99");
  });
});
