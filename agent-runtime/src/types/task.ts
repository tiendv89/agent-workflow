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
  branch: string;
  execution: TaskExecution;
  pr: TaskPr;
  log: TaskLogEntry[];
}
