import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import { parse as parseYaml } from "yaml";

/** Validated agent configuration. */
export interface AgentConfig {
  /** SSH URLs of workspace repositories this agent watches. */
  watches: string[];
  /** Kill switch — false means exit immediately. */
  enabled: boolean;
  /** Maximum random jitter (seconds) before a claim commit. */
  jitter_max_seconds: number;
  /** Hard budget limits per task activation. */
  budget: {
    /** Max tokens (input + output) per task. */
    max_tokens_per_task: number;
    /** Max tool-use loop iterations per task. */
    max_iterations: number;
    /** Token budget for suggested_next_step synthesis. */
    suggested_next_step_max_tokens: number;
  };
  /** Per-run JSONL event log configuration. */
  log_sink: {
    /** Whether to write event logs. */
    enabled: boolean;
  };
}

export interface ValidationError {
  /** JSON pointer to the offending field (e.g. "/budget/max_tokens_per_task"). */
  path: string;
  /** Human-readable description of what went wrong. */
  message: string;
}

export type ValidationResult =
  | { valid: true; config: AgentConfig }
  | { valid: false; errors: ValidationError[] };

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "../../../schemas/agent.schema.json");

let _ajvValidate: ValidateFunction | null = null;

function getValidator(schemaOverride?: object): ValidateFunction {
  if (schemaOverride) {
    const ajv = new Ajv.default({ allErrors: true });
    return ajv.compile(schemaOverride);
  }
  if (!_ajvValidate) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    const ajv = new Ajv.default({ allErrors: true });
    _ajvValidate = ajv.compile(schema);
  }
  return _ajvValidate;
}

function formatAjvErrors(errors: ErrorObject[]): ValidationError[] {
  return errors.map((err: ErrorObject) => {
    const path = err.instancePath || "/";
    let message: string;

    switch (err.keyword) {
      case "required":
        message = `Missing required field: ${err.params.missingProperty}`;
        break;
      case "additionalProperties":
        message = `Unknown field: ${err.params.additionalProperty}`;
        break;
      case "type":
        message = `Expected type "${err.params.type}", got ${typeof err.data}`;
        break;
      case "minimum":
        message = `Value must be >= ${err.params.limit}`;
        break;
      case "minItems":
        message = `Array must have at least ${err.params.limit} item(s)`;
        break;
      case "minLength":
        message = `String must not be empty`;
        break;
      default:
        message = err.message ?? "Validation failed";
    }

    return { path, message };
  });
}

/**
 * Parse a YAML string and validate it against the agent.yaml schema.
 * Returns the validated AgentConfig on success, or structured errors on failure.
 */
export function validateAgentYaml(
  yamlContent: string,
  options?: { schema?: object },
): ValidationResult {
  let data: unknown;
  try {
    data = parseYaml(yamlContent);
  } catch (e) {
    return {
      valid: false,
      errors: [{ path: "/", message: `YAML parse error: ${(e as Error).message}` }],
    };
  }

  if (data === null || data === undefined || typeof data !== "object") {
    return {
      valid: false,
      errors: [{ path: "/", message: "Document must be a YAML mapping (object)" }],
    };
  }

  const validate = getValidator(options?.schema);
  const isValid = validate(data);

  if (!isValid) {
    return {
      valid: false,
      errors: formatAjvErrors(validate.errors ?? []),
    };
  }

  return { valid: true, config: data as AgentConfig };
}

/**
 * Load and validate an agent.yaml file from disk.
 * Throws if the file cannot be read. Returns a ValidationResult.
 */
export function loadAgentYaml(
  filePath: string,
  options?: { schema?: object },
): ValidationResult {
  const content = readFileSync(filePath, "utf-8");
  return validateAgentYaml(content, options);
}
