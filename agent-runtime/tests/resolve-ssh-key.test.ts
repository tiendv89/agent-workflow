/**
 * Tests for resolve-ssh-key.ts — D1 SSH_PRIVATE_KEY env var delivery.
 *
 * Test plan (T1):
 *   1. SSH_PRIVATE_KEY set  → PEM written to temp file (0400), sshKeyPath = tempPath
 *   2. SSH_KEY_PATH set only → sshKeyPath = that path, no write
 *   3. Neither set          → sshKeyPath = undefined, warned = true
 *   4. SSH_PRIVATE_KEY = "" → falsy → falls through to SSH_KEY_PATH branch
 */

import { describe, it, expect, vi } from "vitest";
import { resolveSSHKey, TEMP_SSH_KEY_PATH } from "../src/resolve-ssh-key.js";

const FAKE_PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";
const FAKE_KEY_PATH = "/etc/agent-runtime/ssh/id_rsa";

describe("resolveSSHKey", () => {
  it("writes PEM to temp file and returns its path when SSH_PRIVATE_KEY is set", () => {
    const writeFn = vi.fn();
    const result = resolveSSHKey({ SSH_PRIVATE_KEY: FAKE_PEM }, writeFn);

    expect(writeFn).toHaveBeenCalledOnce();
    expect(writeFn).toHaveBeenCalledWith(TEMP_SSH_KEY_PATH, FAKE_PEM, { mode: 0o400 });
    expect(result.sshKeyPath).toBe(TEMP_SSH_KEY_PATH);
    expect(result.warned).toBe(false);
  });

  it("returns SSH_KEY_PATH directly without writing when SSH_PRIVATE_KEY is absent", () => {
    const writeFn = vi.fn();
    const result = resolveSSHKey({ SSH_KEY_PATH: FAKE_KEY_PATH }, writeFn);

    expect(writeFn).not.toHaveBeenCalled();
    expect(result.sshKeyPath).toBe(FAKE_KEY_PATH);
    expect(result.warned).toBe(false);
  });

  it("returns undefined and sets warned when neither env var is set", () => {
    const writeFn = vi.fn();
    const result = resolveSSHKey({}, writeFn);

    expect(writeFn).not.toHaveBeenCalled();
    expect(result.sshKeyPath).toBeUndefined();
    expect(result.warned).toBe(true);
  });

  it("treats SSH_PRIVATE_KEY='' as absent and falls through to SSH_KEY_PATH", () => {
    const writeFn = vi.fn();
    // Docker Compose expands an unset var to "" — this must not trigger the write path.
    const result = resolveSSHKey({ SSH_PRIVATE_KEY: "", SSH_KEY_PATH: FAKE_KEY_PATH }, writeFn);

    expect(writeFn).not.toHaveBeenCalled();
    expect(result.sshKeyPath).toBe(FAKE_KEY_PATH);
    expect(result.warned).toBe(false);
  });

  it("respects a custom tempKeyPath override", () => {
    const writeFn = vi.fn();
    const customPath = "/custom/id_rsa";
    const result = resolveSSHKey({ SSH_PRIVATE_KEY: FAKE_PEM }, writeFn, customPath);

    expect(writeFn).toHaveBeenCalledWith(customPath, FAKE_PEM, { mode: 0o400 });
    expect(result.sshKeyPath).toBe(customPath);
  });
});
