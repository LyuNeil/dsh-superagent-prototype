#!/bin/sh
# `gitlab` worker command: a small JSON client for the configured GitLab project.
#
#   gitlab api GET  projects/:id/merge_requests/12
#   gitlab api POST projects/:id/merge_requests --data '{"title":"…"}'
#   gitlab api PUT  projects/:id/merge_requests/12/merge
#
# `:id` is replaced with the configured project's URL-encoded path, and every path stays inside that project. The token and
# the project come from files dsh-superagent writes into its state directory, so a worker never handles the token.
set -eu

# The shim strips worker-bin from PATH and runs here; the state directory is the one this script was copied from.
state=${DSH_SUPERAGENT_STATE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
if [ -z "$state" ] || [ ! -f "$state/worker-gitlab-host" ]; then
  echo 'gitlab: this installation has no GitLab account' >&2
  exit 1
fi
host=$(cat "$state/worker-gitlab-host" 2>/dev/null || true)
project=$(cat "$state/worker-gitlab-project" 2>/dev/null || true)
token=$(cat "$state/worker-git-credential" 2>/dev/null || true)
if [ -z "$host" ] || [ -z "$project" ] || [ -z "$token" ]; then
  echo 'gitlab: this installation has no GitLab account' >&2
  exit 1
fi

if [ $# -lt 3 ] || [ "$1" != api ]; then
  echo 'usage: gitlab api <GET|POST|PUT|DELETE> <path> [--data <json>]' >&2
  exit 1
fi
method=$2
path=$3
shift 3
data=
if [ $# -eq 2 ] && [ "$1" = --data ]; then
  data=$2
elif [ $# -ne 0 ]; then
  echo 'gitlab: only --data <json> may follow the path' >&2
  exit 1
fi

encoded=$(printf '%s' "$project" | sed 's,/,\%2F,g')
path=$(printf '%s' "$path" | sed "s,:id,$encoded,g")
# Refuse a path that escapes the configured project, the only one a worker may change.
case "$path" in
  /*|*:*|*..*|"projects/$encoded"|"projects/$encoded"/*) ;;
  *) echo "gitlab: paths are restricted to $project" >&2; exit 1 ;;
esac

set -- -sS -X "$method" -H "PRIVATE-TOKEN: $token" -H 'accept: application/json'
if [ -n "$data" ]; then
  set -- "$@" -H 'content-type: application/json' --data "$data"
fi
body=$(mktemp)
trap 'rm -f "$body"' EXIT
status=$(curl "$@" -o "$body" -w '%{http_code}' "$host/api/v4/$path") || { echo "gitlab: could not reach $host" >&2; exit 1; }
if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "gitlab: $method $path answered $status: $(head -c 2000 "$body")" >&2
  exit 1
fi
cat "$body"
echo
