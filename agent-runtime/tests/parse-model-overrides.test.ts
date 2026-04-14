import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseModelOverrides } from "../src/config/parse-model-overrides.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function buildTasksmd(taskId: string, modelOverridesBlock: string | null): string {
  const num = taskId.replace(/^T/, "");
  const overridesSection =
    modelOverridesBlock !== null
      ? `### Model overrides\n${modelOverridesBlock}\n\n`
      : "";
  return `# Tasks

## T${num} — Example task

### Description
Does something.

### Required skills
- typescript-best-practices

${overridesSection}### Subtasks
- [ ] Do it.

---

## T99 — Next task

### Description
Another task.
`;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("parseModelOverrides", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // ── absent section ──────────────────────────────────────────────────────────

  it("returns empty object when ### Model overrides is absent", () => {
    const md = buildTasksmd("T3", null);
    expect(parseModelOverrides(md, "T3")).toEqual({});
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("returns empty object when ### Model overrides is present but empty", () => {
    const md = buildTasksmd("T3", "");
    expect(parseModelOverrides(md, "T3")).toEqual({});
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("returns empty object when task ID is not found", () => {
    const md = buildTasksmd("T3", null);
    expect(parseModelOverrides(md, "T99")).toEqual({});
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  // ── valid overrides ─────────────────────────────────────────────────────────

  it("parses a single valid phase override", () => {
    const block = `implementation:\n  allowed: [claude-opus-4-6, claude-sonnet-4-6]\n  default: claude-opus-4-6\n`;
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result).toEqual({
      implementation: {
        allowed: ["claude-opus-4-6", "claude-sonnet-4-6"],
        default: "claude-opus-4-6",
      },
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("parses multiple valid phase overrides", () => {
    const block = [
      "implementation:",
      "  allowed: [claude-opus-4-6]",
      "  default: claude-opus-4-6",
      "pr_description:",
      "  allowed: [claude-sonnet-4-6]",
      "  default: claude-sonnet-4-6",
    ].join("\n");
    const md = buildTasksmd("T5", block);
    const result = parseModelOverrides(md, "T5");
    expect(result.implementation?.default).toBe("claude-opus-4-6");
    expect(result.pr_description?.default).toBe("claude-sonnet-4-6");
    expect(result.self_review).toBeUndefined();
    expect(result.suggested_next_step).toBeUndefined();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("is scoped correctly — does not bleed into adjacent task section", () => {
    // T99 in buildTasksmd has no model overrides; only T3 does
    const block = `implementation:\n  allowed: [claude-opus-4-6]\n  default: claude-opus-4-6\n`;
    const md = buildTasksmd("T3", block);
    expect(parseModelOverrides(md, "T99")).toEqual({});
  });

  // ── malformed input — warnings, graceful fallback ───────────────────────────

  it("emits warning and skips unknown phase", () => {
    const block = `unknown_phase:\n  allowed: [claude-sonnet-4-6]\n  default: claude-sonnet-4-6\n`;
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
    const event = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(event.type).toBe("model_override_parse_warning");
    expect(event.reason).toContain("unknown_phase");
  });

  it("emits warning and skips phase with missing default", () => {
    const block = `implementation:\n  allowed: [claude-sonnet-4-6]\n`;
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
    const event = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(event.type).toBe("model_override_parse_warning");
  });

  it("emits warning and skips phase with empty allowed array", () => {
    const block = `implementation:\n  allowed: []\n  default: claude-sonnet-4-6\n`;
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("emits warning and skips phase with non-string allowed entries", () => {
    const block = `implementation:\n  allowed: [123]\n  default: claude-sonnet-4-6\n`;
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("emits warning when block is not a YAML mapping", () => {
    const block = `- item1\n- item2\n`;
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
    const event = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(event.type).toBe("model_override_parse_warning");
  });

  it("emits warning on YAML parse error and returns empty", () => {
    const block = `implementation: {broken: yaml: here\n`;
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result).toEqual({});
    expect(consoleSpy).toHaveBeenCalledOnce();
    const event = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(event.type).toBe("model_override_parse_warning");
    expect(event.reason).toContain("YAML parse error");
  });

  it("includes taskId in warning events", () => {
    const block = `bad_phase:\n  allowed: [m]\n  default: m\n`;
    const md = buildTasksmd("T7", block);
    parseModelOverrides(md, "T7");
    const event = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(event.taskId).toBe("T7");
  });

  it("skips malformed phases but returns valid ones in the same block", () => {
    const block = [
      "implementation:",
      "  allowed: [claude-opus-4-6]",
      "  default: claude-opus-4-6",
      "bad_phase:",
      "  allowed: [claude-sonnet-4-6]",
      "  default: claude-sonnet-4-6",
    ].join("\n");
    const md = buildTasksmd("T3", block);
    const result = parseModelOverrides(md, "T3");
    expect(result.implementation?.default).toBe("claude-opus-4-6");
    expect(Object.keys(result)).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});
