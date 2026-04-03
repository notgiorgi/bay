# bay

`bay` is a Bun CLI for reserving local development ports and tracking who acquired them.

It gives you shell-friendly port acquisition:

```bash
PORT=$(bay acquire)
readarray -t PORTS < <(bay acquire -n 5)
```

It also keeps metadata about where a port was acquired, prevents duplicate acquisition across parallel CLI calls, and stores state in platform-appropriate XDG/macOS directories.

## Commands

```text
bay acquire
bay acquire -n 5
bay acquire 3000 3001
bay check 3000
bay info 3000
bay info
bay info --all
bay release
bay release 3000 3001
bay help
```

## Examples

```bash
PORT=$(bay acquire)
readarray -t PORTS < <(bay acquire -n 3)

bay acquire 3000 3001
bay check 3000
bay info 3000
bay info
bay info --all
bay release
```

For local development before install:

```bash
bun run ./index.ts acquire
bun run ./index.ts info --all
```

## State Storage

`bay` stores data in standard per-user directories.

- Linux config: `$XDG_CONFIG_HOME/bay` or `~/.config/bay`
- Linux state: `$XDG_STATE_HOME/bay` or `~/.local/state/bay`
- macOS config: `~/Library/Application Support/bay`
- macOS state: `~/Library/Application Support/bay/state`

## Build

Build a single-file executable with Bun:

```bash
bun run build
```

This writes `dist/bay`.

## Nix

The repo now includes a `flake.nix`.

```bash
nix develop
nix build
nix run . -- acquire
```

`nix build` produces the packaged `bay` binary in `result/bin/bay`, and `nix develop` gives you a shell with `bun` and `git`.

## Development

```bash
bun test
bun run build
```

## Release CI

GitHub Actions is configured for:

- `CI`: runs tests and a local executable build on Linux and macOS
- `Release`: on tag push `v*`, or manual dispatch for an existing tag, publishes archives plus `.sha256` files for `linux-x64`, `linux-arm64`, `macos-x64`, and `macos-arm64`

To cut a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

That workflow publishes GitHub release assets that are suitable for a later Homebrew formula.
