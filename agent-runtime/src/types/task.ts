/** Task lifecycle statuses. */
export type TaskStatus =
  | "todo"
  | "ready"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

/** Reasons a task may be blocked. Written to task.yaml when status becomes blocked. */
export type BlockedReason =
  | "budget_exceeded"
  | "iteration_cap_exceeded"
  | "no_progress"
  | "model_escalation_requested"
  | "skill_missing"
  | "runtime_error";

/** Who may execute a task. */
export type ActorType = "human" | "agent" | "either";

/** Pull-request lifecycle state. */
export type PrStatus = "not_created" | "open" | "merged" | "closed";

/** One entry in the task's append-only audit log. */
export interface TaskLogEntry {
  action: string;
  by: string;
  at: string;
  note?: string;
  [key: string]: unknown;
}

/** Execution metadata stored on the task. */
export interface TaskExecution {
  actor_type: ActorType;
  last_updated_by: string | null;
  last_updated_at: string | null;
  /** Written by the agent when blocking; a short human-readable triage hint. */
  suggested_next_step?: string | null;
}

/** Pull-request reference stored on the task. */
export interface TaskPr {
  url: string;
  status: PrStatus;
}

/**
 * Written by the orchestrator (or agent) when a task transitions to `blocked`.
 * Captures the exact WIP state so a recovery agent can resume from the same
 * branch and SHA rather than starting from scratch.
 */
export interface BlockedContext {
  /** Branch name carrying the WIP commits (e.g. `feature/my-feature-T3`). */
  wip_branch: string;
  /** HEAD SHA at the time the block was recorded. */
  wip_sha: string;
  /** ISO-8601 timestamp with timezone when the branch was last pushed. */
  pushed_at: string;
}

/** Full task state as stored in tasks/T<n>.yaml. */
export interface Task {
  id: string;
  title: string;
  repo: string;
  status: TaskStatus;
  depends_on: string[];
  blocked_reason: BlockedReason | null;
  /** Structured context for blocked_reason (e.g. current_model for escalation). */
  blocked_details?: string | Record<string, unknown> | null;
  /**
   * WIP branch/SHA snapshot written when the task is blocked.
   * Null when the task has never been blocked, or after a successful completion.
   */
  blocked_context: BlockedContext | null;
  branch: string;
  execution: TaskExecution;
  /** Implementation-repo PR (opened by the agent after work is complete). */
  pr: TaskPr;
  /**
   * Management-repo PR opened at claim time (feature branch → main).
   * Null until the claim commit is pushed and the PR is created.
   */
  workspace_pr: TaskPr | null;
  log: TaskLogEntry[];
}
