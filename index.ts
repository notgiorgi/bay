#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import net from "node:net";

type PortRecord = {
  port: number;
  cwd: string;
  acquiredAt: string;
  acquiredByPid: number;
  hostname: string;
  username: string;
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

const HELP_TEXT = `bay

Acquire, inspect, and release local TCP ports tracked by bay.

Usage:
  bay <command> [options]

Commands:
  acquire [PORT ...]     Acquire one free port, many free ports, or named ports
  check <PORT>           Print whether a port is free right now
  info [PORT]            Show info for one port, this directory, or all tracked ports
  release [PORT ...]     Release named ports or all ports acquired in the current directory
  help [command]         Show top-level or command-specific help

Shell-friendly output:
  bay acquire            Prints exactly one port number
  bay acquire -n 5       Prints one acquired port per line
  bay acquire 3000 3001  Prints acquired ports, one per line
  bay release 3000 3001  Prints released ports, one per line
  bay check 3000         Prints "free" or "in-use"

Examples:
  PORT=$(bay acquire)
  readarray -t PORTS < <(bay acquire -n 3)
  bay acquire 3000 3001
  bay check 3000
  bay info 3000
  bay info
  bay info --all
  bay release
  bay release 3000 3001

State directories:
  Linux:
    config: $XDG_CONFIG_HOME/bay or ~/.config/bay
    state:  $XDG_STATE_HOME/bay or ~/.local/state/bay
  macOS:
    config: ~/Library/Application Support/bay
    state:  ~/Library/Application Support/bay/state

Exit codes:
  0  success
  1  operational failure (for example: port is already in use or lock timeout)
  2  usage error

Run "bay help <command>" for command-specific help.
`;

const ACQUIRE_HELP = `bay acquire

Acquire ports and track them in bay's state file.

Usage:
  bay acquire
  bay acquire -n <COUNT>
  bay acquire <PORT> [PORT ...]

Behavior:
  - With no arguments, acquires exactly one free port.
  - With -n/--count, acquires COUNT free ports.
  - With positional ports, acquires the named ports.
  - Requests are atomic: if one requested port cannot be acquired, none are stored.
  - Successful output is port numbers only, one per line.

Examples:
  PORT=$(bay acquire)
  readarray -t PORTS < <(bay acquire -n 5)
  bay acquire 3000 3001 3002
`;

const CHECK_HELP = `bay check

Check whether a TCP port is currently free to bind.

Usage:
  bay check <PORT>

Output:
  free
  in-use

Exit codes:
  0  port is free
  1  port is in use
  2  usage error
`;

const INFO_HELP = `bay info

Show tracked metadata and current port status.

Usage:
  bay info
  bay info --all
  bay info <PORT>

Behavior:
  - With no arguments, shows ports acquired by bay in the current directory.
  - With --all, shows every port tracked by bay.
  - With a port, shows detailed metadata for that specific port.
  - For tracked ports, bay also checks whether the port is currently free or in use.
`;

const RELEASE_HELP = `bay release

Release ports tracked by bay.

Usage:
  bay release
  bay release <PORT> [PORT ...]

Behavior:
  - With no arguments, releases every port acquired in the current directory.
  - With positional ports, releases those exact tracked ports.
  - Successful output is released port numbers only, one per line.
  - Named releases are atomic: if one named port is not tracked, none are removed.
`;

function printLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function printError(message: string): void {
  process.stderr.write(`bay: ${message}\n`);
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliError(`invalid port "${value}"`, 2);
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`invalid port "${value}"`, 2);
  }

  return port;
}

function parsePositiveCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliError(`invalid count "${value}"`, 2);
  }

  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new CliError(`invalid count "${value}"`, 2);
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
    lockPath: path.join(stateDir, "lock.json"),
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
    return {
      version: 1,
      ports: parsed.ports ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, ports: {} };
    }
    throw error;
  }
}

async function writeState(state: BayState): Promise<void> {
  await ensureStateDir();
  const { statePath } = statePaths();
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, statePath);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function maybeRemoveStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid === "number" && !isProcessAlive(parsed.pid)) {
      await fs.rm(lockPath, { force: true });
      return true;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return true;
    }
    if (error instanceof SyntaxError) {
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
      return true;
    }
  }

  return false;
}

async function withLock<T>(action: () => Promise<T>): Promise<T> {
  await ensureStateDir();
  const { lockPath } = statePaths();
  const deadline = Date.now() + 10_000;

  while (true) {
    try {
      const lockHandle = await fs.open(lockPath, "wx");
      try {
        await lockHandle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );
        return await action();
      } finally {
        await lockHandle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const cleared = await maybeRemoveStaleLock(lockPath);
      if (cleared) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new CliError(`timed out waiting for bay lock at ${lockPath}`);
      }

      await sleep(25);
    }
  }
}

async function canBind(options: net.ListenOptions): Promise<"free" | "in-use" | "unsupported"> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code;
      if (code === "EADDRINUSE") {
        resolve("in-use");
        return;
      }

      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL" || code === "EINVAL") {
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

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width, " ");
}

async function printSinglePortInfo(port: number, record: PortRecord | undefined): Promise<void> {
  const free = await isPortFree(port);
  printLine(`Port: ${port}`);
  printLine(`Tracked by bay: ${record ? "yes" : "no"}`);
  printLine(`Currently free: ${formatBoolean(free)}`);

  if (!record) {
    return;
  }

  printLine(`Directory: ${record.cwd}`);
  printLine(`Acquired at: ${record.acquiredAt}`);
  printLine(`Acquired by PID: ${record.acquiredByPid}`);
  printLine(`Hostname: ${record.hostname}`);
  printLine(`User: ${record.username}`);
}

async function printPortTable(records: PortRecord[]): Promise<void> {
  if (records.length === 0) {
    printLine("No ports acquired by bay.");
    return;
  }

  const rows = await Promise.all(
    records.map(async (record) => ({
      port: String(record.port),
      free: (await isPortFree(record.port)) ? "yes" : "no",
      cwd: record.cwd,
      acquiredAt: record.acquiredAt,
    })),
  );

  const widths = {
    port: Math.max("PORT".length, ...rows.map((row) => row.port.length)),
    free: Math.max("FREE".length, ...rows.map((row) => row.free.length)),
    cwd: Math.max("DIRECTORY".length, ...rows.map((row) => row.cwd.length)),
    acquiredAt: Math.max("ACQUIRED_AT".length, ...rows.map((row) => row.acquiredAt.length)),
  };

  printLine(
    [
      pad("PORT", widths.port),
      pad("FREE", widths.free),
      pad("DIRECTORY", widths.cwd),
      pad("ACQUIRED_AT", widths.acquiredAt),
    ].join("  "),
  );

  for (const row of rows) {
    printLine(
      [
        pad(row.port, widths.port),
        pad(row.free, widths.free),
        pad(row.cwd, widths.cwd),
        pad(row.acquiredAt, widths.acquiredAt),
      ].join("  "),
    );
  }
}

function buildRecord(port: number, cwd: string): PortRecord {
  return {
    port,
    cwd,
    acquiredAt: new Date().toISOString(),
    acquiredByPid: process.pid,
    hostname: os.hostname(),
    username: os.userInfo().username,
  };
}

async function handleAcquire(args: string[]): Promise<number> {
  let count: number | undefined;
  const requestedPorts: number[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      printLine(ACQUIRE_HELP);
      return 0;
    }

    if (arg === "-n" || arg === "--count") {
      const next = args[index + 1];
      if (!next) {
        throw new CliError("missing value for -n/--count", 2);
      }
      count = parsePositiveCount(next);
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CliError(`unknown option "${arg}"`, 2);
    }

    requestedPorts.push(parsePort(arg));
  }

  if (count !== undefined && requestedPorts.length > 0) {
    throw new CliError("cannot combine -n/--count with named ports", 2);
  }

  ensureUniquePorts(requestedPorts);

  const cwd = await getCurrentDir();
  const acquired = await withLock(async () => {
    const state = await readState();
    const ports =
      requestedPorts.length > 0 ? requestedPorts : await allocatePorts(count ?? 1, state);

    for (const port of ports) {
      if (state.ports[String(port)]) {
        throw new CliError(`port ${port} is already acquired by bay`);
      }
      if (!(await isPortFree(port))) {
        throw new CliError(`port ${port} is currently in use`);
      }
    }

    for (const port of ports) {
      state.ports[String(port)] = buildRecord(port, cwd);
    }

    await writeState(state);
    return ports;
  });

  for (const port of acquired) {
    printLine(String(port));
  }

  return 0;
}

async function handleCheck(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printLine(CHECK_HELP);
    return 0;
  }

  if (args.length !== 1) {
    throw new CliError("check expects exactly one port", 2);
  }

  const port = parsePort(args[0]);
  const free = await isPortFree(port);
  printLine(free ? "free" : "in-use");
  return free ? 0 : 1;
}

async function handleInfo(args: string[]): Promise<number> {
  let all = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      printLine(INFO_HELP);
      return 0;
    }

    if (arg === "--all") {
      all = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CliError(`unknown option "${arg}"`, 2);
    }

    positional.push(arg);
  }

  if (all && positional.length > 0) {
    throw new CliError("cannot combine --all with a specific port", 2);
  }

  if (positional.length > 1) {
    throw new CliError("info accepts at most one port", 2);
  }

  const state = await withLock(async () => await readState());

  if (positional.length === 1) {
    const port = parsePort(positional[0]);
    await printSinglePortInfo(port, state.ports[String(port)]);
    return 0;
  }

  const cwd = await getCurrentDir();
  const records = Object.values(state.ports)
    .filter((record) => all || record.cwd === cwd)
    .sort((left, right) => left.port - right.port);

  await printPortTable(records);
  return 0;
}

async function handleRelease(args: string[]): Promise<number> {
  const requested: number[] = [];

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      printLine(RELEASE_HELP);
      return 0;
    }

    if (arg.startsWith("-")) {
      throw new CliError(`unknown option "${arg}"`, 2);
    }

    requested.push(parsePort(arg));
  }

  ensureUniquePorts(requested);

  const cwd = await getCurrentDir();
  const released = await withLock(async () => {
    const state = await readState();

    let portsToRelease: number[];
    if (requested.length > 0) {
      for (const port of requested) {
        if (!state.ports[String(port)]) {
          throw new CliError(`port ${port} is not acquired by bay`);
        }
      }
      portsToRelease = [...requested];
    } else {
      portsToRelease = Object.values(state.ports)
        .filter((record) => record.cwd === cwd)
        .map((record) => record.port)
        .sort((left, right) => left - right);
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

  return 0;
}

function handleHelp(args: string[]): number {
  if (args.length === 0) {
    printLine(HELP_TEXT);
    return 0;
  }

  if (args.length > 1) {
    throw new CliError("help accepts at most one command name", 2);
  }

  const topic = args[0];
  switch (topic) {
    case "acquire":
      printLine(ACQUIRE_HELP);
      return 0;
    case "check":
      printLine(CHECK_HELP);
      return 0;
    case "info":
      printLine(INFO_HELP);
      return 0;
    case "release":
      printLine(RELEASE_HELP);
      return 0;
    default:
      throw new CliError(`unknown help topic "${topic}"`, 2);
  }
}

async function run(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printLine(HELP_TEXT);
    return 0;
  }

  const [command, ...args] = argv;

  switch (command) {
    case "acquire":
      return await handleAcquire(args);
    case "check":
      return await handleCheck(args);
    case "info":
      return await handleInfo(args);
    case "release":
      return await handleRelease(args);
    case "help":
      return handleHelp(args);
    default:
      throw new CliError(`unknown command "${command}"`, 2);
  }
}

async function main(): Promise<void> {
  try {
    const exitCode = await run(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof CliError) {
      printError(error.message);
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
