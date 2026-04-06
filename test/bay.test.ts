import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import packageJson from "../package.json" with { type: "json" };

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

function releaseAssetSuffix(): string {
  const osName =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "linux"
        ? "linux"
        : "unsupported";
  const archName =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "unsupported";

  if (osName === "unsupported" || archName === "unsupported") {
    throw new Error(`unsupported platform for test: ${process.platform}/${process.arch}`);
  }

  return `${osName}-${archName}`;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(50);
  }

  throw new Error("timed out waiting for condition");
}

async function spawnListeningProcess(port: number) {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "--eval",
      `
        import net from "node:net";
        const port = Number(process.argv.at(-1));
        const server = net.createServer();
        server.listen(port, "127.0.0.1");
        setInterval(() => {}, 1000);
      `,
      String(port),
    ],
    stdout: "ignore",
    stderr: "pipe",
  });

  await waitFor(async () => {
    const check = await runBay(["check", String(port)], {
      cwd: repoDir,
      env: process.env,
    });
    return check.exitCode === 1;
  });

  return proc;
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

  test("acquire stores tag and namespace metadata and info shows them", async () => {
    const sandbox = await makeSandbox();
    const acquire = await runBay(
      ["acquire", "--tag", "backend", "--namespace", "sales-app"],
      sandbox,
    );
    const port = acquire.stdout.trim();
    const state = JSON.parse(await fs.readFile(stateFilePath(sandbox), "utf8")) as {
      ports: Record<string, Record<string, unknown>>;
    };

    expect(state.ports[port]?.tag).toBe("backend");
    expect(state.ports[port]?.namespace).toBe("sales-app");

    const info = await runBay(["info", port], sandbox);
    expect(info.stdout).toContain("Tag: backend");
    expect(info.stdout).toContain("Namespace: sales-app");
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

  test("release --kill terminates listening processes on released ports", async () => {
    const sandbox = await makeSandbox();
    const port = await getFreePort();
    const acquire = await runBay(["acquire", String(port)], sandbox);
    expect(acquire.exitCode).toBe(0);

    const listener = await spawnListeningProcess(port);

    try {
      const release = await runBay(["release", "--kill", String(port)], sandbox);
      expect(release.exitCode).toBe(0);
      expect(release.stdout.trim()).toBe(String(port));

      await Promise.race([
        listener.exited,
        (async () => {
          await delay(3_000);
          throw new Error("listener process did not exit");
        })(),
      ]);

      const check = await runBay(["check", String(port)], sandbox);
      expect(check.exitCode).toBe(0);
      expect(check.stdout.trim()).toBe("free");
    } finally {
      listener.kill();
    }
  });

  test("upgrade installs the latest matching release asset", async () => {
    const sandbox = await makeSandbox();
    const releaseTag = "v0.2.0";
    const currentVersion = packageJson.version;
    const archiveName = `bay-${releaseTag}-${releaseAssetSuffix()}.tar.gz`;
    const archivePath = path.join(sandbox.cwd, archiveName);
    const checksumPath = `${archivePath}.sha256`;
    const packageDir = path.join(sandbox.cwd, "upgrade-package");
    const installDir = path.join(sandbox.cwd, "bin");
    const targetPath = path.join(installDir, "bay");
    const installedContents = "#!/bin/sh\necho upgraded\n";

    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "bay"), installedContents, { mode: 0o755 });

    const tar = Bun.spawn({
      cmd: ["tar", "-czf", archivePath, "-C", packageDir, "bay"],
      stdout: "ignore",
      stderr: "pipe",
    });
    const tarExitCode = await tar.exited;
    expect(tarExitCode).toBe(0);

    const checksum = createHash("sha256").update(await fs.readFile(archivePath)).digest("hex");
    await fs.writeFile(checksumPath, `${checksum}  ${archiveName}\n`);

    let serverPort = 0;
    const server = createHttpServer((request, response) => {
      if (!request.url) {
        response.statusCode = 400;
        response.end();
        return;
      }

      if (request.url === "/latest") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            tag_name: releaseTag,
            assets: [
              {
                name: archiveName,
                browser_download_url: `http://127.0.0.1:${serverPort}/${archiveName}`,
              },
              {
                name: `${archiveName}.sha256`,
                browser_download_url: `http://127.0.0.1:${serverPort}/${archiveName}.sha256`,
              },
            ],
          }),
        );
        return;
      }

      if (request.url === `/${archiveName}`) {
        fs.readFile(archivePath).then((data) => response.end(data));
        return;
      }

      if (request.url === `/${archiveName}.sha256`) {
        fs.readFile(checksumPath, "utf8").then((data) => response.end(data));
        return;
      }

      response.statusCode = 404;
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected http server address");
    }
    serverPort = address.port;

    try {
      const upgrade = await runBay(["upgrade"], {
        cwd: sandbox.cwd,
        env: {
          ...sandbox.env,
          BAY_RELEASE_API_URL: `http://127.0.0.1:${serverPort}/latest`,
          BAY_UPGRADE_TARGET: targetPath,
        },
      });

      expect(upgrade.exitCode).toBe(0);
      expect(upgrade.stdout).toContain(`Upgraded bay ${currentVersion} -> 0.2.0`);
      expect(await fs.readFile(targetPath, "utf8")).toBe(installedContents);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  test("info and release can filter by tag and namespace", async () => {
    const sandbox = await makeSandbox();

    const backendAcquire = await runBay(
      ["acquire", "--tag", "backend", "--namespace", "sales-app"],
      sandbox,
    );
    const frontendAcquire = await runBay(
      ["acquire", "--tag", "frontend", "--namespace", "sales-app"],
      sandbox,
    );
    const backendPort = backendAcquire.stdout.trim();
    const frontendPort = frontendAcquire.stdout.trim();

    const infoByTag = await runBay(["info", "--tag", "backend"], sandbox);
    expect(infoByTag.stdout).toContain(backendPort);
    expect(infoByTag.stdout).toContain("backend");
    expect(infoByTag.stdout).not.toContain(frontendPort);

    const infoByNamespace = await runBay(["info", "--namespace", "sales-app"], sandbox);
    expect(infoByNamespace.stdout).toContain(backendPort);
    expect(infoByNamespace.stdout).toContain(frontendPort);
    expect(infoByNamespace.stdout).toContain("sales-app");

    const release = await runBay(["release", "--tag", "backend"], sandbox);
    expect(release.exitCode).toBe(0);
    expect(release.stdout.trim()).toBe(backendPort);

    const backendInfo = await runBay(["info", backendPort], sandbox);
    expect(backendInfo.stdout).toContain("Tracked by bay: no");

    const frontendInfo = await runBay(["info", frontendPort], sandbox);
    expect(frontendInfo.stdout).toContain("Tracked by bay: yes");
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
