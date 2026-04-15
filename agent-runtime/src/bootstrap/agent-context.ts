/**
 * T4: Agent context generator.
 *
 * Pure function — no file I/O. Returns the per-activation CLAUDE.md briefing
 * string that is passed to `claude -p` as the agent's operating context.
 * The caller is responsible for writing the string to disk or piping it.
 */

export interface AgentContextOpts {
  taskId: string;
  featureId: string;
  taskTitle: string;
  taskBranch: string;
  taskRepo: string;
  taskRepoRoot: string;
  workspaceRoot: string;
  gitAuthorEmail: string;
  gitAuthorName: string;
  implementationModel: string;
}

/**
 * Generate the per-activation CLAUDE.md briefing string for an agent.
 *
 * Sections (in order):
 *   1. Preamble — automated context, no interactive session
 *   2. ## Identity — who this agent is
 *   3. ## Your claimed task — what to work on
 *   4. ## What you must do — the exact execution sequence
 *   5. ## Model — which model to use
 *   6. ## Rules — behavioral constraints for headless operation
 */
export function generateAgentContext(opts: AgentContextOpts): string {
  const {
    taskId,
    featureId,
    taskTitle,
    taskBranch,
    taskRepo,
    taskRepoRoot,
    workspaceRoot,
    gitAuthorEmail,
    gitAuthorName,
    implementationModel,
  } = opts;

  return [
    "You are an automated software agent running in a headless container.",
    "There is no interactive session. Do not prompt for input.",
    "Do not ask clarifying questions. Execute the task described below.",
    "",
    "## Identity",
    "",
    `Email: ${gitAuthorEmail}`,
    `Name:  ${gitAuthorName}`,
    "",
    "## Your claimed task",
    "",
    `Workspace root: ${workspaceRoot}`,
    `Feature:        ${featureId}`,
    `Task ID:        ${taskId}`,
    `Title:          ${taskTitle}`,
    `Impl repo:      ${taskRepo}`,
    `Repo root:      ${taskRepoRoot}`,
    `Branch:         ${taskBranch}`,
    "",
    "## What you must do",
    "",
    `1. Run \`/start-implementation ${taskId}\` to begin implementation.`,
    "2. Implement all subtasks described in the task file.",
    "3. Run \`/pr-self-review\` on the completed branch.",
    "4. Run the full test suite (`npx vitest run` and `tsc --noEmit`). All tests must",
    "   pass before opening a PR. Fix any failures and re-run until clean.",
    "5. Run \`/pr-create\` to push and open the pull request.",
    "",
    "Complete all five steps without stopping or asking for confirmation.",
    "",
    "## Model",
    "",
    `Use model: ${implementationModel}`,
    "",
    "## Rules",
    "",
    "- Do not ask clarifying questions. Implement what is specified.",
    "- Do not mark the task done. The PR merge flow handles status transitions.",
    "- Do not modify `status.yaml`, `tasks.md`, or any other feature-level files",
    "  unless the task spec explicitly requires it.",
    "- If you are stuck and cannot proceed, set the task status to `blocked`,",
    "  write a `blocked_reason` and `suggested_next_step`, append a log entry,",
    "  and exit. Do not open a PR for broken or incomplete work.",
  ].join("\n");
}
