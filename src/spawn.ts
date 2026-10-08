import type { ChildProcess } from "node:child_process";

/**
 * Terminates a spawned agent along with anything it started.
 *
 * Agent CLIs routinely spawn their own children — a shell running a test suite,
 * a language server, a build tool. Signalling only the direct child leaves those
 * grandchildren alive, and because they inherit the stdout/stderr pipes they keep
 * the parent's event loop open long after the work is settled.
 */
export const terminate = (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    // The child was started detached, so its pid doubles as the group id.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};