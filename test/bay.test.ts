import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const repoDir = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoDir, "index.ts");

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const tempDirs: string[] = [];

async function makeSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bay-test-"));
  tempDirs.push(root);

  const cwd = path.join(root, "workspace");
  const otherCwd = path.join(root, "workspace-2");
  const xdgConfigHome = path.join(root, "config-home");
  const xdgStateHome = path.join(root, "state-home");

  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(otherCwd, { recursive: true });
  await fs.mkdir(xdgConfigHome, { recursive: true });
  await fs.mkdir(xdgStateHome, { recursive: true });

  return {
    cwd,
    otherCwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_STATE_HOME: xdgStateHome,
    },
  };
}

async function runBay(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", cliPath, ...args],
    cwd: options.cwd,
    env: options.env,
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

function stateFilePath(options: { env: NodeJS.ProcessEnv }): string {
  return path.join(options.env.XDG_STATE_HOME!, "bay", "state.json");
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected address info"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.once("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("bay cli", () => {
  test("acquire with no args prints a single port and info shows metadata", async () => {
    const sandbox = await makeSandbox();
    const acquire = await runBay(["acquire"], sandbox);
    const cwd = await fs.realpath(sandbox.cwd);

    expect(acquire.exitCode).toBe(0);
    expect(acquire.stderr).toBe("");

    const port = Number(acquire.stdout.trim());
    expect(Number.isInteger(port)).toBe(true);

    const info = await runBay(["info", String(port)], sandbox);
    expect(info.exitCode).toBe(0);
    expect(info.stdout).toContain(`Port: ${port}`);
    expect(info.stdout).toContain("Tracked by bay: yes");
    expect(info.stdout).toContain(`Directory: ${cwd}`);
  });

  test("acquire -n prints one port per line", async () => {
    const sandbox = await makeSandbox();
    const acquire = await runBay(["acquire", "-n", "3"], sandbox);

    expect(acquire.exitCode).toBe(0);
    const ports = acquire.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((value) => Number(value));

    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
  });

  test("acquire writes the requested on-disk state format", async () => {
    const sandbox = await makeSandbox();
    const acquire = await runBay(["acquire"], sandbox);
    const port = acquire.stdout.trim();
    const state = JSON.parse(await fs.readFile(stateFilePath(sandbox), "utf8")) as {
      version: number;
      ports: Record<string, Record<string, unknown>>;
    };

    expect(state.version).toBe(1);
    expect(state.ports[port]).toBeDefined();
    expect(state.ports[port]?.dir).toBe(await fs.realpath(sandbox.cwd));
    expect(state.ports[port]?.hostname).toBeDefined();
    expect(state.ports[port]?.user).toBeDefined();
    expect(state.ports[port]?.pid).toBeTypeOf("number");
    expect(state.ports[port]?.acquired_at).toBeTypeOf("string");
    expect(state.ports[port]?.cwd).toBeUndefined();
    expect(state.ports[port]?.username).toBeUndefined();
    expect(state.ports[port]?.acquiredByPid).toBeUndefined();
    expect(state.ports[port]?.acquiredAt).toBeUndefined();
    expect(state.ports[port]?.port).toBeUndefined();
  });

  test("named acquire is atomic when one requested port is already in use", async () => {
    const sandbox = await makeSandbox();
    const freePort = await getFreePort();

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected address info");
    }

    const usedPort = address.port;
    const acquire = await runBay(["acquire", String(freePort), String(usedPort)], sandbox);

    expect(acquire.exitCode).toBe(1);
    expect(acquire.stderr).toContain(`port ${usedPort} is currently in use`);

    const info = await runBay(["info", String(freePort)], sandbox);
    expect(info.stdout).toContain("Tracked by bay: no");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  test("release with no args only releases ports from the current directory", async () => {
    const sandbox = await makeSandbox();

    const first = await runBay(["acquire"], sandbox);
    const second = await runBay(["acquire"], {
      cwd: sandbox.otherCwd,
      env: sandbox.env,
    });

    const firstPort = Number(first.stdout.trim());
    const secondPort = Number(second.stdout.trim());

    const release = await runBay(["release"], sandbox);
    expect(release.exitCode).toBe(0);
    expect(release.stdout.trim()).toBe(String(firstPort));

    const firstInfo = await runBay(["info", String(firstPort)], sandbox);
    expect(firstInfo.stdout).toContain("Tracked by bay: no");

    const secondInfo = await runBay(["info", String(secondPort)], sandbox);
    expect(secondInfo.stdout).toContain("Tracked by bay: yes");
  });

  test("parallel acquires do not return duplicate ports", async () => {
    const sandbox = await makeSandbox();

    const tasks = Array.from({ length: 8 }, () => runBay(["acquire"], sandbox));
    const results = await Promise.all(tasks);

    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }

    const ports = results.map((result) => Number(result.stdout.trim()));
    expect(new Set(ports).size).toBe(results.length);
  });
});
