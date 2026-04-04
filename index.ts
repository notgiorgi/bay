#!/usr/bin/env bun
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import lockfile from "proper-lockfile";
import packageJson from "./package.json" with { type: "json" };

type PortRecord = {
  dir: string;
  hostname: string;
  user: string;
  pid: number;
  acquired_at: string;
};

type LegacyPortRecord = {
  port?: number;
  cwd?: string;
  acquiredAt?: string;
  acquiredByPid?: number;
  hostname?: string;
  username?: string;
  dir?: string;
  user?: string;
  pid?: number;
  acquired_at?: string;
};

type BayState = {
  version: 1;
  ports: Record<string, PortRecord>;
};

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

function printLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function printError(message: string): void {
  process.stderr.write(`bay: ${message}\n`);
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`invalid port "${value}"`);
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(`invalid port "${value}"`);
  }

  return port;
}

function parseCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`invalid count "${value}"`);
  }

  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidArgumentError(`invalid count "${value}"`);
  }

  return count;
}

function ensureUniquePorts(ports: number[]): void {
  const seen = new Set<number>();
  for (const port of ports) {
    if (seen.has(port)) {
      throw new CliError(`duplicate port "${port}"`, 2);
    }
    seen.add(port);
  }
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function resolveConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "bay");
  }

  if (isMac()) {
    return path.join(os.homedir(), "Library", "Application Support", "bay");
  }

  return path.join(os.homedir(), ".config", "bay");
}

function resolveStateDir(): string {
  if (process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, "bay");
  }

  if (isMac()) {
    return path.join(resolveConfigDir(), "state");
  }

  return path.join(os.homedir(), ".local", "state", "bay");
}

function statePaths() {
  const stateDir = resolveStateDir();
  return {
    stateDir,
    statePath: path.join(stateDir, "state.json"),
  };
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(resolveStateDir(), { recursive: true });
}

async function readState(): Promise<BayState> {
  await ensureStateDir();
  const { statePath } = statePaths();

  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BayState>;
    const portEntries = Object.entries(parsed.ports ?? {}).map(([port, record]) => [
      port,
      normalizeRecord(port, record as LegacyPortRecord),
    ]);
    return {
      version: 1,
      ports: Object.fromEntries(portEntries),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, ports: {} };
    }
    throw error;
  }
}

function normalizeRecord(port: string, record: LegacyPortRecord): PortRecord {
  const dir = record.dir ?? record.cwd;
  const user = record.user ?? record.username;
  const pid = record.pid ?? record.acquiredByPid;
  const acquiredAt = record.acquired_at ?? record.acquiredAt;

  if (!dir || !record.hostname || !user || typeof pid !== "number" || !acquiredAt) {
    throw new CliError(`invalid state entry for port ${port}`);
  }

  return {
    dir,
    hostname: record.hostname,
    user,
    pid,
    acquired_at: acquiredAt,
  };
}

async function writeState(state: BayState): Promise<void> {
  await ensureStateDir();
  const { statePath } = statePaths();
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, statePath);
}

async function withLock<T>(action: () => Promise<T>): Promise<T> {
  await ensureStateDir();
  const { stateDir } = statePaths();

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(stateDir, {
      realpath: false,
      lockfilePath: path.join(stateDir, "lock"),
      stale: 15_000,
      update: 5_000,
      retries: {
        retries: 400,
        factor: 1,
        minTimeout: 25,
        maxTimeout: 25,
      },
      onCompromised(error) {
        throw new CliError(`bay lock was compromised: ${error.message}`);
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new CliError(`timed out waiting for bay lock in ${stateDir}: ${error.message}`);
    }
    throw new CliError(`timed out waiting for bay lock in ${stateDir}`);
  }

  try {
    return await action();
  } finally {
    await release?.().catch(() => undefined);
  }
}

async function canBind(options: net.ListenOptions): Promise<"free" | "in-use" | "unsupported"> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve("in-use");
        return;
      }

      if (
        error.code === "EAFNOSUPPORT" ||
        error.code === "EADDRNOTAVAIL" ||
        error.code === "EINVAL"
      ) {
        resolve("unsupported");
        return;
      }

      resolve("in-use");
    });

    server.listen(options, () => {
      server.close(() => resolve("free"));
    });
  });
}

async function isPortFree(port: number): Promise<boolean> {
  const checks: net.ListenOptions[] = [
    { port, host: "127.0.0.1", exclusive: true },
    { port, host: "0.0.0.0", exclusive: true },
    { port, host: "::1", exclusive: true, ipv6Only: true },
    { port, host: "::", exclusive: true, ipv6Only: true },
  ];

  let observedFreeBind = false;

  for (const options of checks) {
    const result = await canBind(options);
    if (result === "in-use") {
      return false;
    }
    if (result === "free") {
      observedFreeBind = true;
    }
  }

  return observedFreeBind;
}

async function reserveEphemeralPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ port: 0, host: "0.0.0.0", exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("failed to resolve an ephemeral port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function allocatePorts(count: number, state: BayState): Promise<number[]> {
  const allocated: number[] = [];
  const seen = new Set(Object.keys(state.ports));
  let attempts = 0;

  while (allocated.length < count && attempts < count * 200) {
    attempts += 1;
    const port = await reserveEphemeralPort();
    if (seen.has(String(port))) {
      continue;
    }
    if (!(await isPortFree(port))) {
      continue;
    }

    seen.add(String(port));
    allocated.push(port);
  }

  if (allocated.length !== count) {
    throw new CliError(`unable to find ${count} free ports`);
  }

  return allocated;
}

async function getCurrentDir(): Promise<string> {
  return await fs.realpath(process.cwd());
}

function buildRecord(cwd: string): PortRecord {
  return {
    dir: cwd,
    hostname: os.hostname(),
    user: os.userInfo().username,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width, " ");
}

async function printSinglePortInfo(port: number, record: PortRecord | undefined): Promise<void> {
  printLine(`Port: ${port}`);
  printLine(`Tracked by bay: ${record ? "yes" : "no"}`);
  printLine(`Currently free: ${await isPortFree(port) ? "yes" : "no"}`);

  if (!record) {
    return;
  }

  printLine(`Directory: ${record.dir}`);
  printLine(`Acquired at: ${record.acquired_at}`);
  printLine(`Acquired by PID: ${record.pid}`);
  printLine(`Hostname: ${record.hostname}`);
  printLine(`User: ${record.user}`);
}

async function printPortTable(records: readonly (readonly [number, PortRecord])[]): Promise<void> {
  if (records.length === 0) {
    printLine("No ports acquired by bay.");
    return;
  }

  const rows = await Promise.all(
    records.map(async ([port, record]) => ({
      port: String(port),
      usedByProcess: (await isPortFree(port)) ? "no" : "yes",
      dir: record.dir,
      acquiredAt: record.acquired_at,
    })),
  );

  const widths = {
    port: Math.max("PORT".length, ...rows.map((row) => row.port.length)),
    usedByProcess: Math.max(
      "USED_BY_PROCESS".length,
      ...rows.map((row) => row.usedByProcess.length),
    ),
    dir: Math.max("DIRECTORY".length, ...rows.map((row) => row.dir.length)),
    acquiredAt: Math.max("ACQUIRED_AT".length, ...rows.map((row) => row.acquiredAt.length)),
  };

  printLine(
    [
      pad("PORT", widths.port),
      pad("USED_BY_PROCESS", widths.usedByProcess),
      pad("DIRECTORY", widths.dir),
      pad("ACQUIRED_AT", widths.acquiredAt),
    ].join("  "),
  );

  for (const row of rows) {
    printLine(
      [
        pad(row.port, widths.port),
        pad(row.usedByProcess, widths.usedByProcess),
        pad(row.dir, widths.dir),
        pad(row.acquiredAt, widths.acquiredAt),
      ].join("  "),
    );
  }
}

async function acquirePorts(namedPorts: number[], count?: number): Promise<void> {
  ensureUniquePorts(namedPorts);
  const cwd = await getCurrentDir();

  const acquired = await withLock(async () => {
    const state = await readState();
    const ports = namedPorts.length > 0 ? namedPorts : await allocatePorts(count ?? 1, state);

    for (const port of ports) {
      if (state.ports[String(port)]) {
        throw new CliError(`port ${port} is already acquired by bay`);
      }
      if (!(await isPortFree(port))) {
        throw new CliError(`port ${port} is currently in use`);
      }
    }

    for (const port of ports) {
      state.ports[String(port)] = buildRecord(cwd);
    }

    await writeState(state);
    return ports;
  });

  for (const port of acquired) {
    printLine(String(port));
  }
}

async function releasePorts(requestedPorts: number[]): Promise<void> {
  ensureUniquePorts(requestedPorts);
  const cwd = await getCurrentDir();

  const released = await withLock(async () => {
    const state = await readState();

    const portsToRelease =
      requestedPorts.length > 0
        ? requestedPorts
        : Object.entries(state.ports)
            .map(([port, record]) => [Number(port), record] as const)
            .filter(([, record]) => record.dir === cwd)
            .map(([port]) => port)
            .sort((left, right) => left - right);

    if (requestedPorts.length > 0) {
      for (const port of requestedPorts) {
        if (!state.ports[String(port)]) {
          throw new CliError(`port ${port} is not acquired by bay`);
        }
      }
    }

    for (const port of portsToRelease) {
      delete state.ports[String(port)];
    }

    await writeState(state);
    return portsToRelease;
  });

  for (const port of released) {
    printLine(String(port));
  }
}

async function showInfo(port: number | undefined, all: boolean): Promise<void> {
  const state = await withLock(async () => await readState());

  if (port !== undefined) {
    await printSinglePortInfo(port, state.ports[String(port)]);
    return;
  }

  const cwd = await getCurrentDir();
  const records = Object.entries(state.ports)
    .map(([port, record]) => [Number(port), record] as const)
    .filter(([, record]) => all || record.dir === cwd)
    .sort((left, right) => left[0] - right[0]);

  await printPortTable(records);
}

function commandNotes(lines: string[]): string {
  return `\n${lines.join("\n")}\n`;
}

function createProgram(): Command {
  const program = new Command();

  program
    .name("bay")
    .description("Acquire, inspect, and release local TCP ports tracked by bay.")
    .version(packageJson.version)
    .showHelpAfterError()
    .showSuggestionAfterError()
    .addHelpCommand("help [command]", "show help for command")
    .addHelpText(
      "after",
      commandNotes([
        "Shell-friendly output:",
        "  PORT=$(bay acquire)",
        "  readarray -t PORTS < <(bay acquire -n 5)",
        "",
        "State directories:",
        "  Linux config: $XDG_CONFIG_HOME/bay or ~/.config/bay",
        "  Linux state:  $XDG_STATE_HOME/bay or ~/.local/state/bay",
        "  macOS config: ~/Library/Application Support/bay",
        "  macOS state:  ~/Library/Application Support/bay/state",
      ]),
    );

  program
    .command("acquire")
    .summary("Acquire one free port, many free ports, or named ports")
    .description("Acquire ports and track them in bay's state file.")
    .argument("[ports...]", "specific ports to acquire")
    .option("-n, --count <count>", "acquire COUNT free ports", parseCount)
    .addHelpText(
      "after",
      commandNotes([
        "Examples:",
        "  bay acquire",
        "  bay acquire -n 5",
        "  bay acquire 3000 3001 3002",
        "",
        "Notes:",
        "  - with no arguments, acquires exactly one free port",
        "  - successful output is port numbers only, one per line",
        "  - requests are atomic: if one requested port fails, none are stored",
      ]),
    )
    .action(async (ports: string[], options: { count?: number }) => {
      const namedPorts = ports.map(parsePort);
      if (options.count !== undefined && namedPorts.length > 0) {
        throw new CliError("cannot combine --count with named ports", 2);
      }

      await acquirePorts(namedPorts, options.count);
    });

  program
    .command("check")
    .summary("Check whether a port is currently free")
    .description("Check whether a TCP port is currently free to bind.")
    .argument("<port>", "port to probe", parsePort)
    .addHelpText(
      "after",
      commandNotes([
        "Output:",
        "  free",
        "  in-use",
        "",
        "Exit codes:",
        "  0 if the port is free",
        "  1 if the port is currently in use",
      ]),
    )
    .action(async (port: number) => {
      const free = await isPortFree(port);
      printLine(free ? "free" : "in-use");
      if (!free) {
        process.exitCode = 1;
      }
    });

  program
    .command("info")
    .summary("Show metadata and current status for tracked ports")
    .description("Show tracked metadata and current port status.")
    .argument("[port]", "specific port to inspect", parsePort)
    .option("--all", "show all tracked ports")
    .addHelpText(
      "after",
      commandNotes([
        "Examples:",
        "  bay info",
        "  bay info --all",
        "  bay info 3000",
        "",
        "Notes:",
        "  - without arguments, shows ports acquired in the current directory",
        "  - tracked ports include a live free/in-use check",
      ]),
    )
    .action(async (port: number | undefined, options: { all?: boolean }) => {
      if (port !== undefined && options.all) {
        throw new CliError("cannot combine --all with a specific port", 2);
      }

      await showInfo(port, Boolean(options.all));
    });

  program
    .command("release")
    .summary("Release tracked ports")
    .description("Release ports tracked by bay.")
    .argument("[ports...]", "specific ports to release")
    .addHelpText(
      "after",
      commandNotes([
        "Examples:",
        "  bay release",
        "  bay release 3000 3001",
        "",
        "Notes:",
        "  - with no arguments, releases ports acquired in the current directory",
        "  - successful output is released port numbers only, one per line",
        "  - named releases are atomic: if one port is missing, none are removed",
      ]),
    )
    .action(async (ports: string[]) => {
      await releasePorts(ports.map(parsePort));
    });

  return program;
}

async function main(): Promise<void> {
  const program = createProgram();

  try {
    const argv = process.argv.slice(2);
    await program.parseAsync(argv.length === 0 ? ["--help"] : argv, { from: "user" });
  } catch (error) {
    if (error instanceof CliError) {
      printError(error.message);
      process.exit(error.exitCode);
    }

    if (error instanceof CommanderError) {
      process.exit(error.exitCode);
    }

    if (error instanceof Error) {
      printError(error.message);
    } else {
      printError("unexpected error");
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
