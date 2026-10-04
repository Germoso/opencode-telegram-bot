import { describe, expect, it } from "vitest";
import { runBotsCommand } from "../../src/multi/commands.js";

async function captureOutput(run: () => Promise<number>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe("runBotsCommand argument handling", () => {
  it("prints usage and fails when no subcommand is given", async () => {
    const { code, stdout } = await captureOutput(() => runBotsCommand([]));
    expect(code).toBe(2);
    expect(stdout).toContain("opencode-telegram bots up");
  });

  it("prints usage on --help with success", async () => {
    const { code, stdout } = await captureOutput(() => runBotsCommand(["--help"]));
    expect(code).toBe(0);
    expect(stdout).toContain("opencode-telegram bots down");
  });

  it("rejects an unknown subcommand", async () => {
    const { code, stderr } = await captureOutput(() => runBotsCommand(["restart"]));
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown bots subcommand: restart");
  });

  it("requires exactly one name for logs", async () => {
    const { code, stderr } = await captureOutput(() => runBotsCommand(["logs"]));
    expect(code).toBe(2);
    expect(stderr).toContain("requires exactly one bot name");

    const extra = await captureOutput(() => runBotsCommand(["logs", "a", "b"]));
    expect(extra.code).toBe(2);
  });

  it("rejects unexpected arguments for status", async () => {
    const { code, stderr } = await captureOutput(() => runBotsCommand(["status", "oops"]));
    expect(code).toBe(2);
    expect(stderr).toContain("Unexpected argument for bots status");
  });

  it("reports stopped status when no supervisor state exists", async () => {
    const { code, stdout } = await captureOutput(() => runBotsCommand(["status"]));
    expect(code).toBe(0);
    expect(stdout).toContain("Service status: stopped");
  });
});
