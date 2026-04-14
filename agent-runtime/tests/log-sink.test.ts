import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openLogSink,
  deriveLogPath,
  toSafeIso,
  type LogEvent,
} from "../src/logging/log-sink.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function readEvents(filePath: string): LogEvent[] {
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

const FEATURE_ID = "test-feature";
const RUN_ISO = "2026-04-14T12:00:00.000Z";

const BASE = {
  featureId: FEATURE_ID,
  taskId: "T4",
  runStartIso: RUN_ISO,
  gitAuthorEmail: "test@example.com",
  workflowCommitSha: "abc1234",
  agentYamlVersion: "0.1.0",
  branch: "feature/test-T4",
  skipGit: true, // no git repo in tests
} as const;

const tmpDirs: string[] = [];

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "log-sink-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// ─── toSafeIso ───────────────────────────────────────────────────────────────

describe("toSafeIso", () => {
  it("replaces all colons with dashes", () => {
    expect(toSafeIso("2026-04-14T12:00:00.000Z")).toBe(
      "2026-04-14T12-00-00.000Z",
    );
  });

  it("leaves timestamps without colons unchanged", () => {
    expect(toSafeIso("2026-04-14")).toBe("2026-04-14");
  });
});

// ─── deriveLogPath ────────────────────────────────────────────────────────────

describe("deriveLogPath", () => {
  it("produces the correct path with safe ISO", () => {
    const path = deriveLogPath(
      "/workspace",
      "my-feature",
      "T4",
      "2026-04-14T12:00:00.000Z",
    );
    expect(path).toBe(
      "/workspace/docs/features/my-feature/logs/T4_2026-04-14T12-00-00.000Z.jsonl",
    );
  });

  it("uses the taskId verbatim", () => {
    const path = deriveLogPath("/root", "feat", "T11", "2026-01-01T00:00:00Z");
    expect(path).toContain("T11_");
  });
});

// ─── openLogSink ─────────────────────────────────────────────────────────────

describe("openLogSink", () => {
  // ── run_started ────────────────────────────────────────────────────────────

  describe("run_started", () => {
    it("writes run_started as the very first line synchronously on open", () => {
      const ws = tmpWorkspace();
      openLogSink({ ...BASE, workspaceRoot: ws }); // no close — just open

      const events = readEvents(
        deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO),
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("run_started");
    });

    it("stamps run_started with the provided runStartIso", () => {
      const ws = tmpWorkspace();
      openLogSink({ ...BASE, workspaceRoot: ws });

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events[0].at).toBe(RUN_ISO);
    });

    it("includes workflow_commit_sha and agent_yaml_version in details", () => {
      const ws = tmpWorkspace();
      openLogSink({ ...BASE, workspaceRoot: ws });

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events[0].details?.workflow_commit_sha).toBe(
        BASE.workflowCommitSha,
      );
      expect(events[0].details?.agent_yaml_version).toBe(BASE.agentYamlVersion);
    });

    it("stamps run_started.by with gitAuthorEmail", () => {
      const ws = tmpWorkspace();
      openLogSink({ ...BASE, workspaceRoot: ws });

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events[0].by).toBe(BASE.gitAuthorEmail);
    });
  });

  // ── logs directory ─────────────────────────────────────────────────────────

  describe("logs directory", () => {
    it("creates the logs/ directory if it does not exist", () => {
      const ws = tmpWorkspace();
      openLogSink({ ...BASE, workspaceRoot: ws });

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events.length).toBeGreaterThan(0);
    });
  });

  // ── emit ───────────────────────────────────────────────────────────────────

  describe("emit", () => {
    it("buffers events — nothing written until close()", async () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      sink.emit({ type: "task_work_iteration", iteration: 1 });

      // Only run_started on disk before close
      const before = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(before).toHaveLength(1);

      await sink.close("done");

      // run_started + task_work_iteration + run_ended
      const after = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(after).toHaveLength(3);
    });

    it("auto-fills at with an ISO timestamp when omitted", async () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      sink.emit({ type: "custom_event" });
      await sink.close("done");

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      const custom = events.find((e) => e.type === "custom_event")!;
      expect(typeof custom.at).toBe("string");
      expect(custom.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("auto-fills by with gitAuthorEmail when omitted", async () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      sink.emit({ type: "custom_event" });
      await sink.close("done");

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      const custom = events.find((e) => e.type === "custom_event")!;
      expect(custom.by).toBe(BASE.gitAuthorEmail);
    });

    it("preserves all optional fields", async () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      sink.emit({
        type: "task_work_iteration",
        iteration: 2,
        tokens: { in: 100, out: 50, total: 150 },
        duration_ms: 1234,
        details: { model: "claude-sonnet-4-6" },
      });
      await sink.close("done");

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      const iter = events.find((e) => e.type === "task_work_iteration")!;
      expect(iter.iteration).toBe(2);
      expect(iter.tokens).toEqual({ in: 100, out: 50, total: 150 });
      expect(iter.duration_ms).toBe(1234);
      expect(iter.details?.model).toBe("claude-sonnet-4-6");
    });

    it("rejects unknown top-level fields", () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      expect(() =>
        // @ts-expect-error intentionally testing unknown field rejection
        sink.emit({ type: "test", mystery_field: "oops" }),
      ).toThrow('Unknown top-level field in log event: "mystery_field"');
    });

    it("throws if called after close()", async () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      await sink.close("done");
      expect(() => sink.emit({ type: "late_event" })).toThrow(
        "Cannot emit after close()",
      );
    });
  });

  // ── close ──────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("appends run_ended as the last line", async () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      await sink.close("done");

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events.at(-1)?.type).toBe("run_ended");
    });

    it("records the correct reason in run_ended", async () => {
      const ws = tmpWorkspace();
      await openLogSink({ ...BASE, workspaceRoot: ws }).close("blocked");

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events.at(-1)?.details?.reason).toBe("blocked");
    });

    it("run_ended carries the gitAuthorEmail as by", async () => {
      const ws = tmpWorkspace();
      await openLogSink({ ...BASE, workspaceRoot: ws }).close("error");

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events.at(-1)?.by).toBe(BASE.gitAuthorEmail);
    });

    it("is idempotent — second call is a no-op", async () => {
      const ws = tmpWorkspace();
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      await sink.close("done");
      await sink.close("error"); // must not append a second run_ended

      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      const endings = events.filter((e) => e.type === "run_ended");
      expect(endings).toHaveLength(1);
    });
  });

  // ── concurrent writers ─────────────────────────────────────────────────────

  describe("concurrent writers (different tasks)", () => {
    it("two sinks write to separate files with no cross-contamination", async () => {
      const ws = tmpWorkspace();

      const sinkA = openLogSink({ ...BASE, workspaceRoot: ws, taskId: "T4" });
      const sinkB = openLogSink({
        ...BASE,
        workspaceRoot: ws,
        taskId: "T5",
        runStartIso: "2026-04-14T12:00:01.000Z",
        branch: "feature/test-T5",
      });

      sinkA.emit({ type: "event_from_T4", details: { owner: "T4" } });
      sinkB.emit({ type: "event_from_T5", details: { owner: "T5" } });

      await Promise.all([sinkA.close("done"), sinkB.close("done")]);

      const eventsA = readEvents(
        deriveLogPath(ws, FEATURE_ID, "T4", "2026-04-14T12:00:00.000Z"),
      );
      const eventsB = readEvents(
        deriveLogPath(ws, FEATURE_ID, "T5", "2026-04-14T12:00:01.000Z"),
      );

      // Each file should only contain events owned by its task
      for (const e of eventsA) {
        if (e.details?.owner) expect(e.details.owner).toBe("T4");
      }
      for (const e of eventsB) {
        if (e.details?.owner) expect(e.details.owner).toBe("T5");
      }
    });

    it("five concurrent sinks each produce an independent file", async () => {
      const ws = tmpWorkspace();
      const sinks = Array.from({ length: 5 }, (_, i) =>
        openLogSink({
          ...BASE,
          workspaceRoot: ws,
          taskId: `T${i + 1}`,
          runStartIso: `2026-04-14T12:00:0${i}.000Z`,
          branch: `feature/test-T${i + 1}`,
        }),
      );

      await Promise.all(sinks.map((s) => s.close("done")));

      for (let i = 0; i < 5; i++) {
        const events = readEvents(
          deriveLogPath(
            ws,
            FEATURE_ID,
            `T${i + 1}`,
            `2026-04-14T12:00:0${i}.000Z`,
          ),
        );
        expect(events[0].type).toBe("run_started");
        expect(events.at(-1)?.type).toBe("run_ended");
      }
    });
  });

  // ── ungraceful close (crash simulation) ───────────────────────────────────

  describe("ungraceful close (crash simulation)", () => {
    it("leaves a valid partial JSONL when close() is never called", () => {
      const ws = tmpWorkspace();
      // Open sink and emit events, but never close (simulates crash)
      const sink = openLogSink({ ...BASE, workspaceRoot: ws });
      sink.emit({ type: "in_flight_event" });

      // Only run_started was written to disk
      const events = readEvents(deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO));
      expect(events).toHaveLength(1);
      // Every line must parse as valid JSON
      const raw = readFileSync(
        deriveLogPath(ws, FEATURE_ID, "T4", RUN_ISO),
        "utf-8",
      );
      for (const line of raw.split("\n").filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
