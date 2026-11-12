#!/bin/sh
# Container entrypoint: renders the profile's machine configuration on first start,
# links the built bundle into that profile, then runs DSH in the foreground.
#
# Everything the service must remember lives under /data (a volume):
#   /data/dsh          - DSH_HOME: profiles and sessions
#   /data/state        - dsh-superagent's stateDir: database, lock, worker shims, worker git config
#   /data/state/work   - Ticket directories (one checkout per Ticket), the default of the
#                        Execution settings' directory
#
# The container runs with host networking, so 127.0.0.1 is the Docker host's loopback.
set -eu

home=${DSH_HOME:?DSH_HOME must be set}
profile=${DSH_SUPERAGENT_PROFILE:?DSH_SUPERAGENT_PROFILE must be set}
port=${DSH_SUPERAGENT_PORT:-3082}
state=${DSH_SUPERAGENT_STATE_DIR:-/data/state}
bundle=/app/dsh-superagent
patch="$home/profiles/$profile/cordis.patch.yml"

die() { echo "dsh-superagent: $*" >&2; exit 1; }

git_host=${DSH_GIT_HOST:-github}
case "$git_host" in github|gitlab) ;; *) die "DSH_GIT_HOST must be github or gitlab, not '$git_host'" ;; esac
for name in DSH_LLM_PROVIDER DSH_LLM_MODEL DSH_LLM_BASE_URL DSH_LLM_API_KEY_ENV; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || die "$name is required (see docker/.env.example)"
done
eval "key=\${$DSH_LLM_API_KEY_ENV:-}"
[ -n "$key" ] || die "$DSH_LLM_API_KEY_ENV is empty; set the model provider's API key"

render() {
  # `envsubst` is not in the image, so substitute the known placeholders and then the
  # Git host's plugin fragment, which enables GitLab's Source on a GitLab deployment.
  sed -e "s#\${DSH_SUPERAGENT_PORT}#$port#g" \
      -e "s#\${DSH_SUPERAGENT_STATE_DIR}#$state#g" \
      -e "s#\${DSH_LLM_PROVIDER}#$DSH_LLM_PROVIDER#g" \
      -e "s#\${DSH_LLM_MODEL}#$DSH_LLM_MODEL#g" \
      -e "s#\${DSH_LLM_BASE_URL}#$DSH_LLM_BASE_URL#g" \
      -e "s#\${DSH_LLM_API_KEY_ENV}#$DSH_LLM_API_KEY_ENV#g" \
      /app/docker/profile.patch.yml.template |
  awk -v fragment="/app/docker/git-host.$git_host.yml" '
    /^# \$\{GIT_HOST_BLOCK\}$/ { while ((getline line < fragment) > 0) print line; next }
    { print }'
}

mkdir -p "$home" "$state" "$state/work" 2>/dev/null || true

# The service runs as `node` (uid 1000). A named volume inherits that ownership from
# the image; a bind mount keeps the host's, which the container may not write.
if ! [ -w "$home" ] || ! [ -w "$state" ]; then
  die "$home and $state must be writable by uid $(id -u) (the container's 'node' user). With a bind mount, run: chown -R 1000:1000 <host directory>"
fi

# The profile is created from DSH's Web template once. `--dump-config` writes the
# profile without starting the server; running it again would replace cordis.patch.yml.
if [ ! -f "$home/profiles/$profile/package.json" ]; then
  echo "dsh-superagent: creating DSH profile '$profile'"
  dsh --profile "$profile" --from-default-profile web --dump-config >/dev/null
fi

# Machine configuration: rendered on first start, then owned by the operator. The
# template marks its own output, so a rendered file is never overwritten, even if the
# operator removes an entry; delete the file to regenerate it from the environment.
if ! grep -q 'dsh-superagent profile configuration' "$patch" 2>/dev/null; then
  echo "dsh-superagent: writing $patch (git host: $git_host)"
  render > "$patch"
fi

# Install this build as the profile's bundle. `link:` points at /app, which is immutable
# in the container image, so an installed entry is already current: skip the pnpm call
# (and its network access) once the profile names it.
if grep -q '"dsh-superagent"' "$home/profiles/$profile/package.json" 2>/dev/null; then
  echo "dsh-superagent: bundle already installed in profile '$profile'"
else
  echo "dsh-superagent: installing bundle $bundle into profile '$profile'"
  dsh plugin --profile "$profile" add "link:$bundle" >/dev/null 2>&1 \
    || die "could not install the bundle into profile '$profile'"
fi

exec dsh --profile "$profile" --no-open