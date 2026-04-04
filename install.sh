#!/bin/sh

set -eu

OWNER="${BAY_GITHUB_OWNER:-notgiorgi}"
REPO="${BAY_GITHUB_REPO:-bay}"
VERSION="${BAY_VERSION:-}"
INSTALL_DIR="${BAY_INSTALL_DIR:-}"
TMPDIR_ROOT="${TMPDIR:-/tmp}"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'bay install: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

download() {
  url="$1"
  output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$output" "$url"
    return
  fi

  fail "need curl or wget to download release assets"
}

fetch_text() {
  url="$1"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
    return
  fi

  fail "need curl or wget to query GitHub releases"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'macos' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

resolve_version() {
  if [ -n "$VERSION" ]; then
    printf '%s' "$VERSION"
    return
  fi

  api_url="https://api.github.com/repos/$OWNER/$REPO/releases/latest"
  tag="$(fetch_text "$api_url" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || fail "could not determine latest release from $api_url"
  printf '%s' "$tag"
}

resolve_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    printf '%s' "$INSTALL_DIR"
    return
  fi

  os_name="$1"
  arch_name="$2"

  if [ "$os_name" = "macos" ] && [ "$arch_name" = "arm64" ]; then
    printf '/opt/homebrew/bin'
    return
  fi

  printf '/usr/local/bin'
}

verify_archive() {
  archive="$1"
  checksum_file="$2"

  if command -v shasum >/dev/null 2>&1; then
    expected="$(cut -d ' ' -f 1 < "$checksum_file")"
    actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
  elif command -v sha256sum >/dev/null 2>&1; then
    expected="$(cut -d ' ' -f 1 < "$checksum_file")"
    actual="$(sha256sum "$archive" | cut -d ' ' -f 1)"
  else
    say "Skipping checksum verification: no shasum or sha256sum available"
    return
  fi

  [ "$expected" = "$actual" ] || fail "checksum mismatch for downloaded archive"
}

install_binary() {
  source_file="$1"
  target_dir="$2"
  target_file="$target_dir/bay"

  mkdir -p "$target_dir"

  if [ -w "$target_dir" ]; then
    install -m 0755 "$source_file" "$target_file"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$target_dir"
    sudo install -m 0755 "$source_file" "$target_file"
    return
  fi

  fallback_dir="$HOME/.local/bin"
  say "No write access to $target_dir and sudo is unavailable; installing to $fallback_dir instead"
  mkdir -p "$fallback_dir"
  install -m 0755 "$source_file" "$fallback_dir/bay"
}

main() {
  need_cmd uname
  need_cmd tar
  need_cmd install
  need_cmd mktemp

  os_name="$(detect_os)"
  arch_name="$(detect_arch)"
  version="$(resolve_version)"
  archive_suffix="$os_name-$arch_name"
  archive_name="bay-$version-$archive_suffix.tar.gz"
  base_url="https://github.com/$OWNER/$REPO/releases/download/$version"
  archive_url="$base_url/$archive_name"
  checksum_url="$archive_url.sha256"
  target_dir="$(resolve_install_dir "$os_name" "$arch_name")"

  workdir="$(mktemp -d "$TMPDIR_ROOT/bay-install.XXXXXX")"
  trap 'rm -rf "$workdir"' EXIT INT TERM HUP

  archive_path="$workdir/$archive_name"
  checksum_path="$workdir/$archive_name.sha256"
  extract_dir="$workdir/extract"

  say "Installing bay $version for $os_name-$arch_name"
  download "$archive_url" "$archive_path"

  if download "$checksum_url" "$checksum_path"; then
    verify_archive "$archive_path" "$checksum_path"
  else
    say "Checksum file not found; continuing without verification"
  fi

  mkdir -p "$extract_dir"
  tar -xzf "$archive_path" -C "$extract_dir"
  [ -f "$extract_dir/bay" ] || fail "release archive did not contain a bay binary"

  install_binary "$extract_dir/bay" "$target_dir"
  say "Installed bay to $target_dir/bay"

  case ":$PATH:" in
    *:"$target_dir":*) ;;
    *)
      say "Note: $target_dir is not currently on PATH"
      ;;
  esac
}

main "$@"
