#!/usr/bin/env bash
# Pack the package, install the tarball into a fresh prefix and check the installed command.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/package.json').version")"
node_bin="$(command -v node)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
prefix="$work/prefix"
empty="$work/empty"
mkdir -p "$prefix" "$empty"

tarball="$(cd "$root" && npm pack --silent --pack-destination "$work" | tail -n 1)"
npm install --silent --global --prefix "$prefix" "$work/$tarball"

cd "$work"

got="$("$prefix/bin/duckwright" --version)"
if [ "$got" != "duckwright $version" ]; then
  echo "version mismatch: expected 'duckwright $version', got '$got'" >&2
  exit 1
fi

# PATH is empty so a machine that has `claude` installed never starts a real run.
# Reaching the claude check also proves the bundled prompt files resolved.
set +e
err="$(env PATH="$empty" "$node_bin" "$prefix/lib/node_modules/duckwright/dist/bin.js" x 2>&1 >/dev/null)"
code=$?
set -e
if [ "$code" -ne 2 ]; then
  echo "expected exit code 2, got $code" >&2
  echo "$err" >&2
  exit 1
fi
case "$err" in
  *"claude CLI not found"*) ;;
  *) echo "stderr missing 'claude CLI not found':" >&2; echo "$err" >&2; exit 1 ;;
esac

# With no terminal and no task, the TUI cannot open and print mode has nothing to run.
set +e
err="$("$prefix/bin/duckwright" </dev/null 2>&1 >/dev/null)"
code=$?
set -e
if [ "$code" -ne 2 ]; then
  echo "expected no-terminal exit code 2, got $code" >&2
  echo "$err" >&2
  exit 1
fi
case "$err" in
  *"no terminal for the TUI"*) ;;
  *) echo "stderr missing 'no terminal for the TUI':" >&2; echo "$err" >&2; exit 1 ;;
esac

# Ink and React must resolve from the installed tarball.
"$node_bin" -e "import('$prefix/lib/node_modules/duckwright/dist/tui/index.js')"

echo "smoke ok"
