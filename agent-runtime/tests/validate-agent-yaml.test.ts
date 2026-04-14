import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgentYaml, type AgentConfig } from "../src/config/validate-agent-yaml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, "fixtures", name), "utf-8");

const schema = JSON.parse(
  readFileSync(resolve(__dirname, "../../schemas/agent.schema.json"), "utf-8"),
);

describe("validateAgentYaml", () => {
  describe("valid configs", () => {
    it("accepts the full example file", () => {
      const result = validateAgentYaml(fixture("valid-agent.yaml"), { schema });
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      expect(result.config.watches).toEqual([
        "git@github.com:mycompany/workspace.git",
      ]);
      expect(result.config.enabled).toBe(true);
      expect(result.config.jitter_max_seconds).toBe(15);
      expect(result.config.budget.max_tokens_per_task).toBe(200000);
      expect(result.config.budget.max_iterations).toBe(3);
      expect(result.config.budget.suggested_next_step_max_tokens).toBe(2000);
      expect(result.config.log_sink.enabled).toBe(true);
    });

    it("accepts a minimal valid config", () => {
      const result = validateAgentYaml(fixture("valid-minimal.yaml"), { schema });
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      expect(result.config.enabled).toBe(false);
      expect(result.config.jitter_max_seconds).toBe(0);
      expect(result.config.budget.max_tokens_per_task).toBe(1);
    });

    it("returns a typed AgentConfig", () => {
      const result = validateAgentYaml(fixture("valid-agent.yaml"), { schema });
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      const config: AgentConfig = result.config;
      expect(config.budget.max_iterations).toBe(3);
    });
  });

  describe("missing required fields", () => {
    it("rejects config missing watches, budget, and log_sink", () => {
      const result = validateAgentYaml(fixture("missing-required.yaml"), { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      const paths = result.errors.map((e) => e.message);
      expect(paths.some((m) => m.includes("watches"))).toBe(true);
      expect(paths.some((m) => m.includes("budget"))).toBe(true);
      expect(paths.some((m) => m.includes("log_sink"))).toBe(true);
    });

    it("provides human-readable messages for missing fields", () => {
      const result = validateAgentYaml(fixture("missing-required.yaml"), { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      for (const err of result.errors) {
        expect(err.message).toBeTruthy();
        expect(err.path).toBeTruthy();
      }
    });
  });

  describe("unknown fields", () => {
    it("rejects config with an unknown top-level field", () => {
      const result = validateAgentYaml(fixture("unknown-field.yaml"), { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(
        result.errors.some((e) => e.message.includes("agent_id")),
      ).toBe(true);
    });
  });

  describe("bad types", () => {
    it("rejects config with wrong types", () => {
      const result = validateAgentYaml(fixture("bad-types.yaml"), { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors.length).toBeGreaterThan(0);
      // watches should be an array
      expect(
        result.errors.some(
          (e) => e.path.includes("watches") || e.message.includes("array"),
        ),
      ).toBe(true);
    });
  });

  describe("constraint violations", () => {
    it("rejects empty watches array", () => {
      const result = validateAgentYaml(fixture("empty-watches.yaml"), { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(
        result.errors.some((e) => e.message.includes("at least")),
      ).toBe(true);
    });

    it("rejects zero max_tokens_per_task", () => {
      const yaml = `
watches:
  - git@github.com:org/repo.git
enabled: true
jitter_max_seconds: 0
budget:
  max_tokens_per_task: 0
  max_iterations: 1
  suggested_next_step_max_tokens: 1
log_sink:
  enabled: true
`;
      const result = validateAgentYaml(yaml, { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(
        result.errors.some(
          (e) =>
            e.path.includes("max_tokens_per_task") && e.message.includes(">="),
        ),
      ).toBe(true);
    });

    it("rejects negative jitter_max_seconds", () => {
      const yaml = `
watches:
  - git@github.com:org/repo.git
enabled: true
jitter_max_seconds: -1
budget:
  max_tokens_per_task: 100
  max_iterations: 1
  suggested_next_step_max_tokens: 1
log_sink:
  enabled: true
`;
      const result = validateAgentYaml(yaml, { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(
        result.errors.some(
          (e) =>
            e.path.includes("jitter_max_seconds") && e.message.includes(">="),
        ),
      ).toBe(true);
    });
  });

  describe("YAML parse errors", () => {
    it("returns an error for invalid YAML", () => {
      const result = validateAgentYaml("{{invalid yaml", { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0].message).toContain("YAML parse error");
    });

    it("rejects a scalar document", () => {
      const result = validateAgentYaml("just a string", { schema });
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors[0].message).toContain("mapping");
    });

    it("rejects an empty document", () => {
      const result = validateAgentYaml("", { schema });
      expect(result.valid).toBe(false);
    });
  });
});
