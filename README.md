# bay

`bay` is a Bun CLI for reserving local development ports and tracking who acquired them.

## Acquiring Ports

Acquire one port and store it in a shell variable:

```bash
PORT=$(bay acquire)
echo "$PORT"
```

Acquire multiple free ports:

```bash
readarray -t PORTS < <(bay acquire -n 5)
printf '%s\n' "${PORTS[@]}"
```

Acquire specific ports:

```bash
bay acquire 3000 3001
```

Check whether a port is currently in use by any process:

```bash
bay check 3000
```

Get a stable, directory-scoped port:

```bash
PORT=$(bay get --tag backend)
FE_PORT=$(bay get --tag front-end)
```

## Looking At Info

Inspect one port:

```bash
bay info 3000
```

See ports acquired in the current directory:

```bash
bay info
```

See every port tracked by `bay`:

```bash
bay info --all
```

Release specific ports or everything acquired in the current directory:

```bash
bay release 3000 3001
bay release
```

## Tagging And Namespacing

Store metadata when acquiring:

```bash
bay acquire --tag backend
bay acquire --namespace sales-app
bay acquire --tag backend --namespace sales-app
```

Filter info by tag or namespace:

```bash
bay info --tag backend
bay info --namespace sales-app
bay info --all --tag backend
```

Release only matching ports in the current directory:

```bash
bay release --tag backend
bay release --namespace sales-app
```

## Install

Install the latest GitHub release binary with:

```bash
curl -fsSL https://raw.githubusercontent.com/notgiorgi/bay/main/install.sh | sh
```

or:

```bash
wget -qO- https://raw.githubusercontent.com/notgiorgi/bay/main/install.sh | sh
```

You can also pin a specific release or install directory:

```bash
BAY_VERSION=v0.1.1 BAY_INSTALL_DIR=/usr/local/bin \
  curl -fsSL https://raw.githubusercontent.com/notgiorgi/bay/main/install.sh | sh
```

## Local Development

Run directly from the repo:

```bash
bun install
bun run ./index.ts acquire
bun run ./index.ts info --all
```

## Build

Build a single-file executable with Bun:

```bash
bun run build
```

This writes `dist/bay`.

## State Storage

`bay` stores data in standard per-user directories.

- Linux config: `$XDG_CONFIG_HOME/bay` or `~/.config/bay`
- Linux state: `$XDG_STATE_HOME/bay` or `~/.local/state/bay`
- macOS config: `~/Library/Application Support/bay`
- macOS state: `~/Library/Application Support/bay/state`

## Development

```bash
bun install
bun test
bun run build
```

## Command Summary

```text
bay acquire
bay acquire -n 5
bay acquire 3000 3001
bay acquire --tag backend --namespace sales-app
bay get --tag backend
bay check 3000
bay info 3000
bay info
bay info --all
bay info --tag backend
bay release
bay release 3000 3001
bay release --tag backend
bay release -k
bay upgrade
bay help
```

## Release CI

GitHub Actions is configured for:

- `CI`: runs tests and a local executable build on Linux and macOS
- `Release`: on tag push `v*`, or manual dispatch for an existing tag, publishes archives plus `.sha256` files for `linux-x64`, `linux-arm64`, `macos-x64`, and `macos-arm64`

To cut a release:

```bash
git tag v0.1.1
git push origin v0.1.1
```

That workflow publishes GitHub release assets that are suitable for a later Homebrew formula.
