#!/bin/sh
# Smoke test for the base image: the tools a worker needs must be present and working.
# The base image installs it as /usr/local/bin/base-verify:
#   docker run --rm dsh-superagent-base:bookworm /usr/local/bin/base-verify
#
# Every check prints a line; a missing tool fails the run.
set -eu

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== system"
for tool in git git-lfs ssh tmux tini curl wget jq rg fd less vi; do
  command -v "$tool" >/dev/null || fail "$tool is missing"
done
echo "   git      $(git --version | cut -d' ' -f3)"
echo "   git-lfs  $(git-lfs version | head -1 | cut -d' ' -f1)"
echo "   os       $(. /etc/os-release && echo "$PRETTY_NAME")"

echo "== node"
node -v
npm -v
test "$(npm config get registry)" != "" || fail "npm registry is unset"
echo "   registry $(npm config get registry)"

echo "== github cli"
gh --version | head -1
echo "   path     $(command -v gh)"

echo "== feishu cli"
lark-cli --version

echo "== python"
python3 --version
python3 -m pip --version
echo "   index    $(python3 -c 'import configparser; c=configparser.ConfigParser(); c.read("/etc/pip.conf"); print(c.get("global","index-url", fallback="(unset)"))')"
echo "   compiler $(cc --version | head -1)"

echo "== python wheels (glibc, no compiler needed)"
python3 -m venv /tmp/verify-venv
/tmp/verify-venv/bin/pip install -q --no-cache-dir lz4==4.4.5 zstandard==0.25.0
/tmp/verify-venv/bin/python -c 'import lz4, zstandard; print("   lz4/zstandard import ok")'
rm -rf /tmp/verify-venv

echo "== user"
echo "   uid      $(id -u) (the application image runs as node, uid 1000)"

echo "ALL BASE CHECKS PASSED"
