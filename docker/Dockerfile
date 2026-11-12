# dsh-superagent as a long-running container service.
#
# Two images:
#   dsh-superagent-base  (docker/base/Dockerfile) - the machine: Debian, Node, the GitHub
#                        CLI, Python with pip/venv and a build toolchain, lark-cli, git.
#                        Rebuild it only when that environment changes.
#   dsh-superagent       (this file)              - the tidy-up: the built bundle, DSH, the
#                        start-up script and the /data layout. Rebuild it per change.
#
# Build, from the repository root:
#   docker build -f docker/base/Dockerfile -t dsh-superagent-base:bookworm docker/base
#   docker build -f docker/Dockerfile --build-arg BASE_IMAGE=dsh-superagent-base:bookworm -t dsh-superagent:local .
#
# Run it with `network_mode: host` (docker/docker-compose.yml): DSH's web server and
# dsh-superagent's management API refuse to bind anything but 127.0.0.1, and the panel
# checks the Host header, so a published port cannot stand in for host networking.

ARG BASE_IMAGE=dsh-superagent-base:bookworm

# ==== The bundle =============================================================
# These two stages run on the base image, so the build uses the base's Node and npm.
FROM ${BASE_IMAGE} AS deps
ARG PNPM_VERSION=11.7.0
# The base sets npm's registry globally for root; pnpm keeps its own, so the build passes it on.
ARG NPM_REGISTRY
WORKDIR /src
# pnpm keeps its own registry setting and reads npm's config file as a fallback, so the
# build writes the registry with npm rather than `pnpm config set` (which insists on a
# PNPM_HOME bin directory being on PATH).
# pnpm reads the user's npmrc and NPM_CONFIG_REGISTRY; both are set here so the build
# never falls back to npmjs.org, which is slow on many networks.
RUN set -eux; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    if [ -n "${NPM_REGISTRY}" ]; then \
        npm config set registry "${NPM_REGISTRY}" --global; \
        printf 'registry=%s\n' "${NPM_REGISTRY}" > /root/.npmrc; \
    fi; \
    pnpm --version
COPY package.json pnpm-lock.yaml ./
# pnpm filters optional dependencies by the running platform; on Debian the native
# rolldown binding (and anything else glibc-only) must be installed, so libc is named
# explicitly. Without it pnpm installs no native binding and `pnpm build` fails.
RUN pnpm install --frozen-lockfile --config.supportedArchitectures.libc=glibc \
 && ls node_modules/.pnpm | grep -q '^@rolldown+binding-linux-x64-gnu@' 

FROM deps AS build
COPY . .
RUN pnpm build

# ==== The service ============================================================
FROM ${BASE_IMAGE}
ARG DSH_VERSION=0.2.1-rc.3
ARG PNPM_VERSION=11.7.0
ARG NPM_REGISTRY
ENV NODE_ENV=production \
    HOME=/home/node \
    DSH_HOME=/data/dsh \
    DSH_SUPERAGENT_STATE_DIR=/data/state \
    DSH_SUPERAGENT_PROFILE=superagent \
    DSH_SUPERAGENT_PORT=3082 \
    DSH_SUPERAGENT_URL=http://127.0.0.1:3082

# DSH runs the bundle. pnpm is what `dsh plugin add` forwards to; the base image carries
# it only in the build stages, so the service installs its own copy here.
RUN set -eux; \
    if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}" --global; fi; \
    npm install -g --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}"; \
    (test -e /usr/local/bin/dsh || ln -sf "$(npm root -g)/@deepseek-ai/dsh/lib/bin.js" /usr/local/bin/dsh); \
    dsh --version; pnpm --version

# The bundle. `lib/` is built in the build stage; `dsh plugin add link:` only installs a
# symlink, so the runtime dependencies the bundle externalizes (package.json's
# `dependencies`) are installed here, next to the bundle.
# Each directory is copied on its own: with several sources, COPY merges their
# contents into the destination instead of keeping their names, and the bundle reads
# prompts/, skills/ and locale/ by path.
COPY --from=build /src/lib /app/dsh-superagent/lib
COPY --from=build /src/prompts /app/dsh-superagent/prompts
COPY --from=build /src/skills /app/dsh-superagent/skills
COPY --from=build /src/locale /app/dsh-superagent/locale
COPY --from=build /src/package.json /src/cordis.patch.yml /app/dsh-superagent/
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY docker/profile.patch.yml.template docker/git-host.github.yml docker/git-host.gitlab.yml /app/docker/
COPY docker/status.py /usr/local/bin/dsh-superagent-status
COPY docker/healthcheck.py /usr/local/bin/dsh-superagent-healthcheck
COPY docker/bin/lark-bot /usr/local/bin/lark-bot
COPY docker/bin/gh-agent /usr/local/bin/gh-agent
COPY scripts/dsh-superagent /app/dsh-superagent/scripts/dsh-superagent
COPY docs /app/dsh-superagent/docs
# Directories under /data: the DSH home, the state directory, ticket workspaces, the Feishu bot's config, the
# place a GitLab deployment keeps its token file, and the Python and pnpm caches. A new container reuses
# them all through the volume.
RUN set -eux; \
    chmod +x /app/docker/entrypoint.sh /usr/local/bin/dsh-superagent-status /usr/local/bin/dsh-superagent-healthcheck \
        /usr/local/bin/lark-bot /usr/local/bin/gh-agent; \
    cd /app/dsh-superagent; \
    npm install --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund; \
    mkdir -p /data/dsh /data/state /data/state/work /data/lark-cli /data/secrets /data/gh /data/.cache; \
    chown -R node:node /data /home/node; \
    chmod 700 /data/dsh /data/state /data/lark-cli /data/secrets /data/gh /data/.cache

# The pip cache belongs on the volume, so a base image that ships its own pip.conf is
# not overridden here; the application only adds the cache location for `node`.
RUN set -eux; \
    mkdir -p /home/node/.config/pip; \
    printf '[global]\ncache-dir = /data/.cache/pip\n' > /home/node/.config/pip/pip.conf; \
    chown -R node:node /home/node/.config

# Workers run as this user with `danger-full-access`, so it is the container's only
# unprivileged account: nothing they run can touch the image or the host's root.
USER node
WORKDIR /app/dsh-superagent
EXPOSE 3082

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD dsh-superagent-healthcheck

# Debian installs tini as /usr/bin/tini; Alpine had it under /sbin.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]