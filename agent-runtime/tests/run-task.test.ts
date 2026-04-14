/**
 * Unit tests for src/loop/run-task.ts
 *
 * Uses an injectable AnthropicClient mock to script responses, and a temporary
 * filesystem to hold task YAML / tasks.md fixtures. skipGit: true prevents git
 * operations from running in the test environment.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import { runTask } from "../src/loop/run-task.js";
import type { RunTaskOptions, AnthropicClient } from "../src/loop/run-task.js";
import type { Task } from "../src/types/task.js";
import type { ModelPolicy } from "../src/config/resolve-model-policy.js";
import type { AgentConfig } from "../src/config/validate-agent-yaml.js";
import type { LogSink } from "../src/logging/log-sink.js";
import type Anthropic from "@anthropic-ai/sdk";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FEATURE_ID = "test-feature";
const TASK_ID = "T6";

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

const BASE_AGENT_CONFIG: AgentConfig = {
  watches: ["git@github.com:org/repo.git"],
  enabled: true,
  jitter_max_seconds: 0,
  budget: {
    max_tokens_per_task: 50_000,
    max_iterations: 10,
    suggested_next_step_max_tokens: 500,
  },
  log_sink: { enabled: true },
};

const BASE_TASK: Task = {
  id: TASK_ID,
  title: "Test task",
  repo: "workflow",
  status: "in_progress",
  depends_on: [],
  blocked_reason: null,
  branch: "feature/test-feature-T6",
  execution: {
    actor_type: "agent",
    last_updated_by: "agent@test.com",
    last_updated_at: "2026-04-14T00:00:00Z",
  },
  pr: {
    url: "",
    status: "not_created",
  },
  log: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-task-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeWorkspace(
  task: Partial<Task> = {},
  tasksmdContent?: string,
): { workspaceRoot: string } {
  const workspaceRoot = makeTempDir();
  const tasksDir = join(
    workspaceRoot,
    "docs",
    "features",
    FEATURE_ID,
    "tasks",
  );
  mkdirSync(tasksDir, { recursive: true });

  const fullTask: Task = { ...BASE_TASK, ...task };
  writeFileSync(
    join(tasksDir, `${TASK_ID}.yaml`),
    yamlStringify(fullTask),
    "utf-8",
  );

  if (tasksmdContent !== undefined) {
    writeFileSync(
      join(workspaceRoot, "docs", "features", FEATURE_ID, "tasks.md"),
      tasksmdContent,
      "utf-8",
    );
  }

  return { workspaceRoot };
}

function readTaskYaml(workspaceRoot: string): Task {
  const content = readFileSync(
    join(workspaceRoot, "docs", "features", FEATURE_ID, "tasks", `${TASK_ID}.yaml`),
    "utf-8",
  );
  return parseYaml(content) as Task;
}

/** Make a mock log sink that records emitted events. */
function makeMockLogSink(): LogSink & { events: ReturnType<LogSink["emit"]>[] } {
  const events: Parameters<LogSink["emit"]>[0][] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
    async close() {},
  };
}

/** Build a scripted Anthropic client from a list of Message responses. */
function makeScriptedClient(responses: Anthropic.Message[]): AnthropicClient & {
  readonly callCount: number;
  readonly lastParams: Anthropic.MessageCreateParamsNonStreaming | null;
} {
  let callCount = 0;
  let lastParams: Anthropic.MessageCreateParamsNonStreaming | null = null;

  const client = {
    get callCount() {
      return callCount;
    },
    get lastParams() {
      return lastParams;
    },
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        lastParams = params;
        const response = responses[callCount];
        callCount++;
        if (!response) {
          throw new Error(`Mock: no scripted response for call #${callCount}`);
        }
        return response;
      },
    },
  };
  return client;
}

/** Create a Message with stop_reason: "end_turn". */
function endTurnMessage(tokenOverride: Partial<Anthropic.Usage> = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Task complete." }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      ...tokenOverride,
    },
  };
}

/** Create a Message with a tool_use block. */
function toolUseMessage(
  toolName: string,
  toolInput: Record<string, unknown>,
  tokenOverride: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: `tu_${Math.random().toString(36).slice(2)}`,
        name: toolName,
        input: toolInput,
      },
    ],
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      ...tokenOverride,
    },
  };
}

/** Base RunTaskOptions — override fields as needed. */
function makeOpts(
  workspaceRoot: string,
  overrides: Partial<RunTaskOptions> = {},
): RunTaskOptions {
  return {
    taskId: TASK_ID,
    featureId: FEATURE_ID,
    workspaceRoot,
    workflowRoot: makeTempDir(), // no skills needed for most tests
    taskRepoRoot: makeTempDir(),
    agentConfig: BASE_AGENT_CONFIG,
    workspaceModelPolicy: WORKSPACE_POLICY,
    logSink: makeMockLogSink(),
    gitAuthorEmail: "agent@test.com",
    skipGit: true,
    ...overrides,
  };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runTask — successful completion", () => {
  it("returns { outcome: 'in_review' } when model returns end_turn immediately", async () => {
    const { workspaceRoot } = makeWorkspace();
    const client = makeScriptedClient([endTurnMessage()]);
    const logSink = makeMockLogSink();

    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: client, logSink }));

    expect(result.outcome).toBe("in_review");
  });

  it("marks task.yaml status as in_review on success", async () => {
    const { workspaceRoot } = makeWorkspace();
    const client = makeScriptedClient([endTurnMessage()]);

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    const task = readTaskYaml(workspaceRoot);
    expect(task.status).toBe("in_review");
    expect(task.execution.last_updated_by).toBe("agent@test.com");
    expect(task.log.at(-1)?.action).toBe("moved_to_in_review");
  });

  it("emits task_work_iteration event for each loop iteration", async () => {
    const { workspaceRoot } = makeWorkspace();
    // 1 tool call, then end_turn
    const client = makeScriptedClient([
      toolUseMessage("read_file", { path: "README.md" }),
      endTurnMessage(),
    ]);
    const logSink = makeMockLogSink();

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client, logSink }));

    const iterEvents = logSink.events.filter((e) => e.type === "task_work_iteration");
    expect(iterEvents).toHaveLength(2);
    expect((iterEvents[0] as { iteration: number }).iteration).toBe(1);
    expect((iterEvents[1] as { iteration: number }).iteration).toBe(2);
  });

  it("records token counts in task_work_iteration events", async () => {
    const { workspaceRoot } = makeWorkspace();
    const client = makeScriptedClient([
      endTurnMessage({ input_tokens: 200, output_tokens: 75 }),
    ]);
    const logSink = makeMockLogSink();

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client, logSink }));

    const iterEvent = logSink.events.find((e) => e.type === "task_work_iteration") as
      | { tokens: { in: number; out: number; total: number } }
      | undefined;
    expect(iterEvent?.tokens.in).toBe(200);
    expect(iterEvent?.tokens.out).toBe(75);
    expect(iterEvent?.tokens.total).toBe(275);
  });
});

// ── Budget exceeded ───────────────────────────────────────────────────────────

describe("runTask — budget exceeded", () => {
  it("returns { outcome: 'blocked', reason: 'budget_exceeded' } when token cap hit", async () => {
    const { workspaceRoot } = makeWorkspace();
    // Each call costs 200 tokens; cap is 150
    const client = makeScriptedClient([
      endTurnMessage({ input_tokens: 100, output_tokens: 100 }),
    ]);
    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      budget: { ...BASE_AGENT_CONFIG.budget, max_tokens_per_task: 150 },
    };

    const result = await runTask(
      makeOpts(workspaceRoot, { anthropicClient: client, agentConfig }),
    );

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toBe("budget_exceeded");
    }
  });

  it("marks task.yaml as blocked with budget_exceeded", async () => {
    const { workspaceRoot } = makeWorkspace();
    const client = makeScriptedClient([
      endTurnMessage({ input_tokens: 100, output_tokens: 100 }),
    ]);
    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      budget: { ...BASE_AGENT_CONFIG.budget, max_tokens_per_task: 150 },
    };

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client, agentConfig }));

    const task = readTaskYaml(workspaceRoot);
    expect(task.status).toBe("blocked");
    expect(task.blocked_reason).toBe("budget_exceeded");
  });
});

// ── Iteration cap exceeded ────────────────────────────────────────────────────

describe("runTask — iteration cap exceeded", () => {
  it("returns { outcome: 'blocked', reason: 'iteration_cap_exceeded' } after max_iterations", async () => {
    const { workspaceRoot } = makeWorkspace();
    // max_iterations = 2: allow 2 API calls, block on iteration 3
    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      budget: { ...BASE_AGENT_CONFIG.budget, max_iterations: 2 },
    };
    // Script 5 responses; the cap should trigger before exhausting them
    const responses = Array.from({ length: 5 }, () =>
      toolUseMessage("bash", { command: "echo hello" }),
    );
    const client = makeScriptedClient(responses);

    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: client, agentConfig }));

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toBe("iteration_cap_exceeded");
    }
  });

  it("makes exactly max_iterations API calls before blocking", async () => {
    const { workspaceRoot } = makeWorkspace();
    const maxIter = 3;
    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      budget: { ...BASE_AGENT_CONFIG.budget, max_iterations: maxIter },
    };
    const responses = Array.from({ length: 10 }, () =>
      toolUseMessage("bash", { command: "echo hello" }),
    );
    const client = makeScriptedClient(responses);

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client, agentConfig }));

    // max_iterations = 3 means iterations 1, 2, 3 each make an API call.
    // Iteration 4 blocks before the call.
    expect(client.callCount).toBe(maxIter);
  });

  it("marks task.yaml as blocked with iteration_cap_exceeded", async () => {
    const { workspaceRoot } = makeWorkspace();
    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      budget: { ...BASE_AGENT_CONFIG.budget, max_iterations: 1 },
    };
    const client = makeScriptedClient([
      toolUseMessage("bash", { command: "echo hi" }),
      toolUseMessage("bash", { command: "echo hi" }),
    ]);

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client, agentConfig }));

    const task = readTaskYaml(workspaceRoot);
    expect(task.status).toBe("blocked");
    expect(task.blocked_reason).toBe("iteration_cap_exceeded");
  });
});

// ── No-progress detection ─────────────────────────────────────────────────────

describe("runTask — no-progress detection", () => {
  it("returns no_progress when identical tool calls appear in 3 consecutive iterations", async () => {
    const { workspaceRoot } = makeWorkspace();
    // Same tool call repeated ≥ 3 times
    const sameCall = toolUseMessage("bash", { command: "echo stuck" });
    const client = makeScriptedClient([sameCall, sameCall, sameCall, sameCall]);

    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toBe("no_progress");
    }
  });

  it("does NOT trigger no_progress if calls vary", async () => {
    const { workspaceRoot } = makeWorkspace();
    // Different tool calls each iteration → should NOT trigger
    const responses = [
      toolUseMessage("bash", { command: "echo a" }),
      toolUseMessage("bash", { command: "echo b" }),
      toolUseMessage("bash", { command: "echo c" }),
      endTurnMessage(),
    ];
    const client = makeScriptedClient(responses);

    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    expect(result.outcome).toBe("in_review");
  });

  it("marks task.yaml as blocked with no_progress", async () => {
    const { workspaceRoot } = makeWorkspace();
    const sameCall = toolUseMessage("bash", { command: "echo stuck" });
    const client = makeScriptedClient([sameCall, sameCall, sameCall]);

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    const task = readTaskYaml(workspaceRoot);
    expect(task.status).toBe("blocked");
    expect(task.blocked_reason).toBe("no_progress");
  });
});

// ── Model escalation ──────────────────────────────────────────────────────────

describe("runTask — escalation path", () => {
  it("returns { outcome: 'blocked', reason: 'model_escalation_requested' } when escalate tool called", async () => {
    const { workspaceRoot } = makeWorkspace();
    const client = makeScriptedClient([
      toolUseMessage("escalate", {
        reason: "This task requires reasoning beyond my current model.",
      }),
    ]);

    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toBe("model_escalation_requested");
      expect((result.details as Record<string, unknown>)["current_model"]).toBe(
        "claude-sonnet-4-6",
      );
    }
  });

  it("writes current_model in blocked_details", async () => {
    const { workspaceRoot } = makeWorkspace();
    const client = makeScriptedClient([
      toolUseMessage("escalate", { reason: "Need Opus." }),
    ]);

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    const task = readTaskYaml(workspaceRoot);
    expect(task.blocked_reason).toBe("model_escalation_requested");
    const details = task.blocked_details as Record<string, unknown>;
    expect(details["current_model"]).toBe("claude-sonnet-4-6");
  });
});

// ── Runtime error path ────────────────────────────────────────────────────────

describe("runTask — runtime error path", () => {
  it("returns { outcome: 'blocked', reason: 'runtime_error' } on uncaught error", async () => {
    const { workspaceRoot } = makeWorkspace();
    const badClient: AnthropicClient = {
      messages: {
        async create() {
          throw new Error("Simulated network failure");
        },
      },
    };

    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: badClient }));

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toBe("runtime_error");
    }
  });

  it("marks task.yaml as blocked with runtime_error (never leaves in_progress)", async () => {
    const { workspaceRoot } = makeWorkspace();
    const badClient: AnthropicClient = {
      messages: {
        async create() {
          throw new Error("API down");
        },
      },
    };

    await runTask(makeOpts(workspaceRoot, { anthropicClient: badClient }));

    const task = readTaskYaml(workspaceRoot);
    expect(task.status).toBe("blocked");
    expect(task.blocked_reason).toBe("runtime_error");
    // blocked_details should contain the error message
    const details = task.blocked_details as Record<string, unknown>;
    expect(typeof details["error"]).toBe("string");
  });

  it("includes error message in details", async () => {
    const { workspaceRoot } = makeWorkspace();
    const badClient: AnthropicClient = {
      messages: {
        async create() {
          throw new Error("Specific error message");
        },
      },
    };

    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: badClient }));

    if (result.outcome === "blocked" && result.reason === "runtime_error") {
      const details = result.details as Record<string, unknown>;
      expect(details["error"]).toContain("Specific error message");
    }
  });
});

// ── Model policy resolution ───────────────────────────────────────────────────

describe("runTask — model policy resolution", () => {
  it("uses workspace default model when no task-level override", async () => {
    const { workspaceRoot } = makeWorkspace();
    let capturedModel: string | undefined;
    const client: AnthropicClient = {
      messages: {
        async create(params) {
          capturedModel = params.model;
          return endTurnMessage();
        },
      },
    };

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    expect(capturedModel).toBe("claude-sonnet-4-6");
  });

  it("uses task-level model override when present in tasks.md", async () => {
    const tasksmdContent = `## T6 — Test task

### Description
Test description.

### Required skills

### Model overrides
implementation:
  allowed: [claude-opus-4-6]
  default: claude-opus-4-6
`;

    const { workspaceRoot } = makeWorkspace({}, tasksmdContent);
    let capturedModel: string | undefined;
    const client: AnthropicClient = {
      messages: {
        async create(params) {
          capturedModel = params.model;
          return endTurnMessage();
        },
      },
    };

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    expect(capturedModel).toBe("claude-opus-4-6");
  });

  it("falls back to first allowed model when default is not in allowed list", async () => {
    // resolvePhasePolicy already handles this via model_fallback event
    const { workspaceRoot } = makeWorkspace();
    const policyWithMismatch: ModelPolicy = {
      ...WORKSPACE_POLICY,
      implementation: {
        allowed: ["claude-haiku-4-5-20251001"],
        default: "claude-opus-4-6", // not in allowed
      },
    };
    let capturedModel: string | undefined;
    const client: AnthropicClient = {
      messages: {
        async create(params) {
          capturedModel = params.model;
          return endTurnMessage();
        },
      },
    };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTask(
      makeOpts(workspaceRoot, {
        anthropicClient: client,
        workspaceModelPolicy: policyWithMismatch,
      }),
    );

    expect(capturedModel).toBe("claude-haiku-4-5-20251001");
    consoleSpy.mockRestore();
  });
});

// ── Skill loading ─────────────────────────────────────────────────────────────

describe("runTask — skill loading", () => {
  it("includes skill body in system prompt when skill SKILL.md exists", async () => {
    const tasksmdContent = `## T6 — Test task

### Description
Test description.

### Required skills
- test-skill
`;
    const { workspaceRoot } = makeWorkspace({}, tasksmdContent);

    // Create workflow repo with the skill
    const workflowRoot = makeTempDir();
    const skillDir = join(workflowRoot, "technical_skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "## Test Skill\nThis is the skill content.",
      "utf-8",
    );

    let capturedSystem: string | undefined;
    const client: AnthropicClient = {
      messages: {
        async create(params) {
          // system is an array of content blocks
          if (Array.isArray(params.system)) {
            capturedSystem = (params.system[0] as { text: string }).text;
          } else {
            capturedSystem = params.system as string | undefined;
          }
          return endTurnMessage();
        },
      },
    };

    await runTask(
      makeOpts(workspaceRoot, { anthropicClient: client, workflowRoot }),
    );

    expect(capturedSystem).toContain("test-skill");
    expect(capturedSystem).toContain("This is the skill content.");
  });

  it("proceeds without error when skill SKILL.md is missing", async () => {
    const tasksmdContent = `## T6 — Test task

### Description
Test description.

### Required skills
- nonexistent-skill
`;
    const { workspaceRoot } = makeWorkspace({}, tasksmdContent);
    const client = makeScriptedClient([endTurnMessage()]);

    // Should not throw — missing skills are silently skipped
    const result = await runTask(makeOpts(workspaceRoot, { anthropicClient: client }));

    expect(result.outcome).toBe("in_review");
  });
});

// ── Log sink events ───────────────────────────────────────────────────────────

describe("runTask — log sink event fields", () => {
  it("task_work_iteration event includes model, stop_reason, and tool_calls", async () => {
    const { workspaceRoot } = makeWorkspace();
    const client = makeScriptedClient([
      toolUseMessage("bash", { command: "ls" }),
      endTurnMessage(),
    ]);
    const logSink = makeMockLogSink();

    await runTask(makeOpts(workspaceRoot, { anthropicClient: client, logSink }));

    const firstIter = logSink.events.find(
      (e) => e.type === "task_work_iteration" && (e as { iteration: number }).iteration === 1,
    ) as { details: Record<string, unknown> } | undefined;

    expect(firstIter?.details["model"]).toBe("claude-sonnet-4-6");
    expect(firstIter?.details["stop_reason"]).toBe("tool_use");
    expect(firstIter?.details["tool_calls"]).toEqual(["bash"]);
  });
});
