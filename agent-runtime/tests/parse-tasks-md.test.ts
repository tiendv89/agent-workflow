import { describe, it, expect, vi, afterEach } from "vitest";
import { parseTasksMd } from "../src/eligibility/parse-tasks-md.js";

// Capture stdout to verify warning events
function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
    lines.push(msg);
  });
  fn();
  spy.mockRestore();
  return lines;
}

describe("parseTasksMd", () => {
  describe("valid required-skills sections", () => {
    it("parses a single task with one skill", () => {
      const content = `
## T1 — Do something

### Description
Some description.

### Required skills
- typescript-best-practices

### Subtasks
- [ ] item
`.trim();
      const result = parseTasksMd(content);
      expect(result["T1"]).toEqual({ requiredSkills: ["typescript-best-practices"] });
    });

    it("parses a task with multiple skills", () => {
      const content = `
## T2 — Build API

### Required skills
- typescript-best-practices
- nestjs-best-practices
- go-best-practices

### Subtasks
- [ ] item
`.trim();
      const result = parseTasksMd(content);
      expect(result["T2"]).toEqual({
        requiredSkills: ["typescript-best-practices", "nestjs-best-practices", "go-best-practices"],
      });
    });

    it("parses multiple tasks in one file", () => {
      const content = `
## T1 — First task

### Required skills
- typescript-best-practices

---

## T2 — Second task

### Required skills
- python-best-practices
- data-engineer
`.trim();
      const result = parseTasksMd(content);
      expect(result["T1"]).toEqual({ requiredSkills: ["typescript-best-practices"] });
      expect(result["T2"]).toEqual({
        requiredSkills: ["python-best-practices", "data-engineer"],
      });
    });

    it("handles skill slugs with numbers and hyphens", () => {
      const content = `
## T3 — Task

### Required skills
- airflow-3
- go-best-practices
- python-data
`.trim();
      const result = parseTasksMd(content);
      expect(result["T3"]).toEqual({
        requiredSkills: ["airflow-3", "go-best-practices", "python-data"],
      });
    });
  });

  describe("absent or empty required-skills sections", () => {
    it("returns empty requiredSkills when ### Required skills is absent", () => {
      const content = `
## T4 — Task with no skills

### Description
No skills needed.

### Subtasks
- [ ] item
`.trim();
      const result = parseTasksMd(content);
      expect(result["T4"]).toEqual({ requiredSkills: [] });
    });

    it("returns empty requiredSkills for an empty ### Required skills section", () => {
      const content = `
## T5 — Pure text task

### Required skills

### Subtasks
- [ ] item
`.trim();
      const result = parseTasksMd(content);
      expect(result["T5"]).toEqual({ requiredSkills: [] });
    });

    it("ignores prose comments in the skills block (e.g. '(empty — …)')", () => {
      const content = `
## T6 — No-code task

### Required skills

(empty — pure markdown / YAML edits, no language-specific skill applies)

### Subtasks
- [ ] item
`.trim();
      const lines = captureStdout(() => {
        const result = parseTasksMd(content);
        expect(result["T6"]).toEqual({ requiredSkills: [] });
      });
      // No warning should be emitted for prose comments
      expect(lines.every((l) => !l.includes("tasksmd_parse_warning"))).toBe(true);
    });

    it("ignores blank lines between skill entries", () => {
      const content = `
## T7 — Task

### Required skills
- typescript-best-practices

- python-best-practices

### Subtasks
`.trim();
      const result = parseTasksMd(content);
      expect(result["T7"]).toEqual({
        requiredSkills: ["typescript-best-practices", "python-best-practices"],
      });
    });
  });

  describe("malformed required-skills sections", () => {
    it("emits warning and omits task when slug contains uppercase letters", () => {
      const content = `
## T8 — Bad task

### Required skills
- TypeScript-best-practices
`.trim();
      const lines = captureStdout(() => {
        const result = parseTasksMd(content);
        // Task omitted due to invalid slug
        expect(result["T8"]).toBeUndefined();
      });
      const warnings = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "tasksmd_parse_warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].taskId).toBe("T8");
      expect(warnings[0].reason).toContain("TypeScript-best-practices");
    });

    it("emits warning and omits task when slug contains spaces", () => {
      const content = `
## T9 — Bad task

### Required skills
- my invalid slug
`.trim();
      const lines = captureStdout(() => {
        const result = parseTasksMd(content);
        expect(result["T9"]).toBeUndefined();
      });
      const warnings = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "tasksmd_parse_warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].taskId).toBe("T9");
    });

    it("emits warning and omits task when slug starts with a digit alone (invalid pattern)", () => {
      // "3" alone is invalid per ^[a-z0-9][a-z0-9-]*$ — wait, "3" is a single char that IS [a-z0-9].
      // The pattern allows single-char slugs that are [a-z0-9]. Let me use a slug starting with -
      const content = `
## T10 — Bad task

### Required skills
- -invalid-start
`.trim();
      const lines = captureStdout(() => {
        const result = parseTasksMd(content);
        expect(result["T10"]).toBeUndefined();
      });
      const warnings = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "tasksmd_parse_warning");
      expect(warnings).toHaveLength(1);
    });

    it("stops at first invalid slug and omits remaining valid slugs for that task", () => {
      const content = `
## T11 — Mixed task

### Required skills
- typescript-best-practices
- INVALID
- python-best-practices
`.trim();
      const lines = captureStdout(() => {
        const result = parseTasksMd(content);
        // Whole task omitted because second slug is invalid
        expect(result["T11"]).toBeUndefined();
      });
      const warnings = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "tasksmd_parse_warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].taskId).toBe("T11");
    });

    it("only omits the malformed task, not its neighbors", () => {
      const content = `
## T12 — Good task

### Required skills
- typescript-best-practices

## T13 — Bad task

### Required skills
- INVALID

## T14 — Another good task

### Required skills
- python-best-practices
`.trim();
      const lines = captureStdout(() => {
        const result = parseTasksMd(content);
        expect(result["T12"]).toEqual({ requiredSkills: ["typescript-best-practices"] });
        expect(result["T13"]).toBeUndefined(); // malformed
        expect(result["T14"]).toEqual({ requiredSkills: ["python-best-practices"] });
      });
      const warnings = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "tasksmd_parse_warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].taskId).toBe("T13");
    });
  });

  describe("heading format", () => {
    it("requires the em-dash separator in the heading", () => {
      // Headings without — are not recognised as task sections
      const content = `
## T15 No dash here

### Required skills
- typescript-best-practices
`.trim();
      const result = parseTasksMd(content);
      // T15 should not be parsed (no em-dash)
      expect(result["T15"]).toBeUndefined();
    });

    it("handles high-numbered tasks (e.g. T100)", () => {
      const content = `
## T100 — High numbered task

### Required skills
- typescript-best-practices
`.trim();
      const result = parseTasksMd(content);
      expect(result["T100"]).toEqual({ requiredSkills: ["typescript-best-practices"] });
    });

    it("does not confuse index table entries with task headings", () => {
      const content = `
# Tasks — my-feature

| ID | Title |
|----|-------|
| T1 | Something |

## T1 — Something

### Required skills
- typescript-best-practices
`.trim();
      const result = parseTasksMd(content);
      expect(Object.keys(result)).toEqual(["T1"]);
      expect(result["T1"]).toEqual({ requiredSkills: ["typescript-best-practices"] });
    });
  });

  describe("real tasks.md shape", () => {
    it("parses the actual distributed-agent-team tasks.md structure correctly", () => {
      // Minimal reproduction of the real file's T5 section
      const content = `
## T5 — Implement zero-token eligibility matcher

### Description
Pure-code filter.

### Required skills
- typescript-best-practices

### Subtasks
- [ ] Implement match.ts
`.trim();
      const result = parseTasksMd(content);
      expect(result["T5"]).toEqual({ requiredSkills: ["typescript-best-practices"] });
    });

    it("handles tasks with no-skill prose comment (like T1 in the real file)", () => {
      const content = `
## T1 — Update workflow rules

### Description
Pure markdown edits.

### Required skills

(empty — pure markdown / YAML edits, no language-specific skill applies)

### Subtasks
- [ ] W1
`.trim();
      const lines = captureStdout(() => {
        const result = parseTasksMd(content);
        expect(result["T1"]).toEqual({ requiredSkills: [] });
      });
      expect(lines.filter((l) => l.includes("tasksmd_parse_warning"))).toHaveLength(0);
    });
  });
});
