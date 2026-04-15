/**
 * SSH key resolution — D1 (SSH_PRIVATE_KEY env var delivery).
 *
 * Priority:
 *   1. SSH_PRIVATE_KEY env var (raw PEM) → write to tempKeyPath (mode 0400)
 *   2. SSH_KEY_PATH env var → use as-is
 *   3. Neither → return undefined + set warned = true
 *
 * The function is extracted from main.ts so it can be unit-tested in isolation.
 */

import { writeFileSync } from "node:fs";

export const TEMP_SSH_KEY_PATH = "/tmp/agent_id_rsa";

export interface SSHKeyEnv {
  SSH_PRIVATE_KEY?: string;
  SSH_KEY_PATH?: string;
}

export interface ResolveSSHKeyResult {
  /** Resolved path to the SSH private key file, or undefined if not available. */
  sshKeyPath: string | undefined;
  /** True when neither env var was set — caller should emit a warning. */
  warned: boolean;
}

/**
 * Resolve the SSH key path from environment variables.
 *
 * @param env          - Object with SSH_PRIVATE_KEY and/or SSH_KEY_PATH fields.
 * @param writeFn      - Injectable write function (defaults to fs.writeFileSync).
 * @param tempKeyPath  - Temp file path for PEM content (defaults to TEMP_SSH_KEY_PATH).
 */
export function resolveSSHKey(
  env: SSHKeyEnv,
  writeFn: (path: string, data: string, opts: { mode: number }) => void = writeFileSync,
  tempKeyPath: string = TEMP_SSH_KEY_PATH,
): ResolveSSHKeyResult {
  if (env.SSH_PRIVATE_KEY) {
    writeFn(tempKeyPath, env.SSH_PRIVATE_KEY, { mode: 0o400 });
    return { sshKeyPath: tempKeyPath, warned: false };
  }
  if (env.SSH_KEY_PATH) {
    return { sshKeyPath: env.SSH_KEY_PATH, warned: false };
  }
  return { sshKeyPath: undefined, warned: true };
}
