#!/usr/bin/env bash
# Install the wheel from <dist-dir> into a fresh venv and check the installed command.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <dist-dir>" >&2
  exit 64
fi

# Resolve everything that depends on the current directory before we cd away.
root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$(cd "$1" && pwd)"
version="$(python3 -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["project"]["version"])' "$root/pyproject.toml")"

shopt -s nullglob
wheels=("$dist"/*.whl)
if [ "${#wheels[@]}" -ne 1 ]; then
  echo "expected exactly one wheel in $dist, found ${#wheels[@]}" >&2
  exit 1
fi

venv_parent="$(mktemp -d)"
work="$(mktemp -d)"
trap 'rm -rf "$venv_parent" "$work"' EXIT
venv="$venv_parent/venv"

python3 -m venv "$venv"
"$venv/bin/pip" install --quiet --disable-pip-version-check "${wheels[0]}"

cd "$work"

got="$("$venv/bin/duckwright" --version)"
if [ "$got" != "duckwright $version" ]; then
  echo "version mismatch: expected 'duckwright $version', got '$got'" >&2
  exit 1
fi

# PATH is restricted so a machine that has `claude` installed never starts a real run.
# Reaching the claude check also proves both bundled prompt files resolved.
set +e
err="$(PATH="$venv/bin" "$venv/bin/duckwright" x 2>&1 >/dev/null)"
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

echo "smoke ok"
