import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class PortProcessManager {
  private static async runCommand(cmd: string[]): Promise<CommandResult> {
    const proc = Bun.spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  }

  private static isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }

      if (code === "EPERM") {
        return true;
      }

      return false;
    }
  }

  private static async waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) {
        return true;
      }
      await delay(50);
    }

    return !this.isPidAlive(pid);
  }

  private static async findListeningPidsWithLsof(port: number): Promise<number[] | undefined> {
    if (!Bun.which("lsof")) {
      return undefined;
    }

    const result = await this.runCommand(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`failed to inspect port ${port} with lsof: ${result.stderr.trim()}`);
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
  }

  private static async findListeningPidsWithSs(port: number): Promise<number[] | undefined> {
    if (process.platform !== "linux" || !Bun.which("ss")) {
      return undefined;
    }

    const result = await this.runCommand(["ss", "-ltnp", `sport = :${port}`]);
    if (result.exitCode !== 0) {
      throw new Error(`failed to inspect port ${port} with ss: ${result.stderr.trim()}`);
    }

    const matches = result.stdout.matchAll(/pid=(\d+)/g);
    return [...matches]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isInteger(value));
  }

  static async findListeningPids(port: number): Promise<number[]> {
    const lsofPids = await this.findListeningPidsWithLsof(port);
    if (lsofPids !== undefined) {
      return [...new Set(lsofPids)];
    }

    const ssPids = await this.findListeningPidsWithSs(port);
    if (ssPids !== undefined) {
      return [...new Set(ssPids)];
    }

    throw new Error("could not inspect listening processes: install lsof or ss");
  }

  static async terminatePid(pid: number): Promise<void> {
    if (!this.isPidAlive(pid)) {
      return;
    }

    process.kill(pid, "SIGTERM");
    if (await this.waitForPidExit(pid, 1500)) {
      return;
    }

    process.kill(pid, "SIGKILL");
    if (await this.waitForPidExit(pid, 1500)) {
      return;
    }

    throw new Error(`failed to terminate process ${pid}`);
  }

  static async killProcessesForPorts(ports: number[]): Promise<void> {
    const pids = new Set<number>();

    for (const port of ports) {
      for (const pid of await this.findListeningPids(port)) {
        if (pid !== process.pid) {
          pids.add(pid);
        }
      }
    }

    for (const pid of [...pids].sort((left, right) => left - right)) {
      await this.terminatePid(pid);
    }
  }
}
