/**
 * Parses the `### Required skills` subsection for every task in a tasks.md file.
 *
 * Grammar (from technical-design.md §Q6 detail):
 *   - Task heading:      `## T<n> — <title>`  (must include the em-dash separator)
 *   - Skills block:      `### Required skills` within the task section
 *   - Skill entry:       `- <slug>` where slug matches `^[a-z0-9][a-z0-9-]*$`
 *   - Section boundary:  next `###`, `##`, or EOF
 *
 * Absence of `### Required skills` → task requires no skills (valid; no warning).
 * Any `- ` line with an invalid slug → emit `tasksmd_parse_warning` and omit that task.
 * Non-`- ` lines in the block (prose comments, blank lines) are silently ignored.
 */

/** Slug must match directory names under workflow/technical_skills/. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Skills extracted for one task. */
export interface TaskSkillInfo {
  requiredSkills: string[];
}

/** Emitted to stdout when a ### Required skills subsection is malformed. */
export interface TasksMdParseWarning {
  type: "tasksmd_parse_warning";
  taskId: string;
  reason: string;
}

function emitWarning(warning: TasksMdParseWarning): void {
  console.log(JSON.stringify(warning));
}

/**
 * Extract the body of a task section from after its heading line to the next
 * `## ` heading or EOF.
 */
function extractTaskSection(content: string, numericId: string): string | null {
  // Heading must contain the em-dash separator: ## T<n> — <title>
  const headingRegex = new RegExp(`^## T${numericId}\\s+—`, "m");
  const headingMatch = headingRegex.exec(content);
  if (!headingMatch) return null;

  const headingLineEnd = content.indexOf("\n", headingMatch.index);
  if (headingLineEnd === -1) return null;

  const afterHeading = content.slice(headingLineEnd + 1);

  // Scope ends at the next `## ` heading
  const nextHeadingMatch = /^## /m.exec(afterHeading);
  return nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
}

/**
 * Extract the raw text of the `### Required skills` block from within a task
 * section. Returns null if the subsection is absent.
 */
function extractRequiredSkillsBlock(taskSection: string): string | null {
  const blockMatch = /^### Required skills[ \t]*(?:\n|$)/im.exec(taskSection);
  if (!blockMatch) return null;

  const afterBlock = taskSection.slice(blockMatch.index + blockMatch[0].length);

  // Block ends at the next subsection (### or ##) or end of task section
  const nextHeadingMatch = /^##+ /m.exec(afterBlock);
  return nextHeadingMatch ? afterBlock.slice(0, nextHeadingMatch.index) : afterBlock;
}

/**
 * Parse a full tasks.md file and return required skills per task.
 *
 * Keys are task IDs (e.g. "T5"). Tasks with absent or empty `### Required skills`
 * sections are included with `requiredSkills: []`. Tasks with malformed sections
 * emit a `tasksmd_parse_warning` event and are **omitted** from the result —
 * the caller treats them as ineligible.
 *
 * @param content - Full text of a tasks.md file.
 * @returns Record mapping task ID → TaskSkillInfo.
 */
export function parseTasksMd(content: string): Record<string, TaskSkillInfo> {
  const result: Record<string, TaskSkillInfo> = {};

  // Scan for task headings: ## T<n> — <title>
  const headingRegex = /^## T(\d+)\s+—/gm;
  let headingMatch: RegExpExecArray | null;

  while ((headingMatch = headingRegex.exec(content)) !== null) {
    const numericId = headingMatch[1]!;
    const taskId = `T${numericId}`;

    const taskSection = extractTaskSection(content, numericId);
    if (taskSection === null) {
      // Heading found but section could not be extracted — shouldn't happen
      emitWarning({
        type: "tasksmd_parse_warning",
        taskId,
        reason: "Could not extract task section — malformed tasks.md structure",
      });
      continue;
    }

    const skillsBlock = extractRequiredSkillsBlock(taskSection);

    if (skillsBlock === null) {
      // No ### Required skills subsection → task needs no skills
      result[taskId] = { requiredSkills: [] };
      continue;
    }

    // Parse skill entries from the block
    const lines = skillsBlock.split("\n");
    const slugs: string[] = [];
    let malformed = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue; // blank lines are not skill entries

      if (!trimmed.startsWith("- ")) {
        // Non-bullet lines (prose comments like "(empty — …)") are silently ignored
        continue;
      }

      const slug = trimmed.slice(2).trim();
      if (!SLUG_PATTERN.test(slug)) {
        emitWarning({
          type: "tasksmd_parse_warning",
          taskId,
          reason: `Invalid slug "${slug}" in ### Required skills — must match ^[a-z0-9][a-z0-9-]*$`,
        });
        malformed = true;
        break;
      }

      slugs.push(slug);
    }

    if (!malformed) {
      result[taskId] = { requiredSkills: slugs };
    }
    // Malformed tasks are omitted; the warning already surfaced above
  }

  return result;
}
