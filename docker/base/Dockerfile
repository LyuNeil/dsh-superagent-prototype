# Base image: the machine a dsh-superagent worker needs, and nothing about
# dsh-superagent itself.
#
# Build it only when the environment changes (a language toolchain, a CLI, a mirror).
# The application image (../Dockerfile) builds `FROM` this one, so routine changes to the
# bundle or its start-up script rebuild in seconds.
#
#   docker build -f docker/base/Dockerfile -t dsh-superagent-base:bookworm docker/base
#   docker build -f docker/Dockerfile -t dsh-superagent:local .
#
# Everything installed here is on the image's own filesystem: no volume, no state. The
# application image adds /data and the dsh-superagent bundle.
#
# Debian is the host distribution because workers run arbitrary projects: glibc has the
# wheels and prebuilt binaries that musl (Alpine) lacks, such as lz4, zstandard, torch,
# opencv and Node native modules.

# The default names the mirror this host can pull; a network with Docker Hub overrides it.
ARG DEBIAN_IMAGE=adlp-dockerhub-cn-beijing.cr.volces.com/library/debian:12.12-slim
FROM ${DEBIAN_IMAGE}

ARG APT_MIRROR=http://mirrors.aliyun.com/debian
ARG APT_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
ARG NODE_VERSION=24.19.0
ARG NODE_MIRROR=https://mirrors.aliyun.com/nodejs-release
ARG GH_VERSION=2.60.0
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG LARK_CLI_VERSION=1.0.100
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# ==== System packages ========================================================
# git, git-lfs      - worker checkouts, worktrees and large files
# openssh-client    - git over SSH, and GitHub's SSH address rewrite target
# python3, pip, venv- a Python toolchain for workers that develop Python projects
# build-essential   - C extensions a Python project compiles at install time
# libpq/libmysql    - common database client libraries
# jq, ripgrep, fd   - shell helpers an agent uses for reading and searching
# tmux, tini, curl  - the bundle's control script, the init process, and downloads
# ca-certificates   - HTTPS to every host above
#
# The apt mirror is an argument: a network that reaches another mirror overrides it.
RUN set -eux; \
    printf 'deb [trusted=yes] %s bookworm main contrib non-free\n' "${APT_MIRROR}" > /etc/apt/sources.list; \
    printf 'deb [trusted=yes] %s bookworm-updates main contrib non-free\n' "${APT_MIRROR}" >> /etc/apt/sources.list; \
    printf 'deb [trusted=yes] %s bookworm-security main contrib non-free\n' "${APT_SECURITY_MIRROR}" >> /etc/apt/sources.list; \
    rm -f /etc/apt/sources.list.d/* 2>/dev/null || true; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget xz-utils unzip git git-lfs openssh-client \
        python3 python3-pip python3-venv build-essential \
        libpq-dev default-libmysqlclient-dev jq ripgrep fd-find tmux tini \
        procps less vim-tiny; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# `fd` is packaged as `fdfind` on Debian.
RUN ln -sf "$(command -v fdfind)" /usr/local/bin/fd

# ==== Node.js ================================================================
# Node ships as a self-contained tarball; Debian's own package lags the version
# dsh requires. Installed from a mirror because nodejs.org is not reachable everywhere.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac; \
    curl -fsSL --retry 3 "${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; \
    node -v; npm -v; \
    npm config set registry "${NPM_REGISTRY}" --global; \
    npm config set fetch-retries 5 --global; \
    npm config set maxsockets 32 --global

# ==== GitHub CLI =============================================================
# Debian's gh (2.23) is older than the 2.48 dsh-superagent needs. The official GitHub
# release is a static glibc binary that runs here; the apt repository downloads at
# ~30 KB/s on some networks, which makes a base build take twenty minutes.
#
# A release tarball in docker/base/gh/ is used when it is there, which keeps an air-gapped
# build off the network; otherwise the tarball is fetched from GH_MIRROR.
ARG GH_TARGET_ARCH=amd64
ARG GH_LOCAL_TARBALL=
ARG GH_MIRROR=https://github.com/cli/cli/releases/download
# `gh-local` is a build context directory: a vendored tarball sits in docker/base/gh/.
COPY gh /tmp/gh-local
RUN set -eux; \
    mkdir -p /tmp/gh; \
    local_tarball="${GH_LOCAL_TARBALL:-gh_${GH_VERSION}_linux_${GH_TARGET_ARCH}.tar.gz}"; \
    if [ -f "/tmp/gh-local/${local_tarball}" ]; then \
        echo "using vendored ${local_tarball}"; \
        cp "/tmp/gh-local/${local_tarball}" /tmp/gh/gh.tar.gz; \
    else \
        curl -fL --http1.1 --retry 10 --retry-all-errors --retry-delay 3 --max-time 1800 \
            "${GH_MIRROR}/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_TARGET_ARCH}.tar.gz" -o /tmp/gh/gh.tar.gz; \
    fi; \
    tar -xzf /tmp/gh/gh.tar.gz -C /tmp/gh; \
    install -m 0755 "/tmp/gh/gh_${GH_VERSION}_linux_${GH_TARGET_ARCH}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh; \
    gh --version | head -1

# ==== lark-cli ===============================================================
# The Feishu CLI downloads its own binary in a postinstall, which needs curl and
# network access. A failed postinstall leaves only the shim, so the version is checked.
RUN set -eux; \
    npm install -g --allow-scripts=@larksuite/cli "@larksuite/cli@${LARK_CLI_VERSION}"; \
    lark-cli --version

# ==== pip ====================================================================
# The index and cache are set for every user, so a worker's `pip install` needs no
# flags, and the cache lives under /data in the application image.
RUN set -eux; \
    mkdir -p /etc/pip; \
    printf '[global]\nindex-url = %s\n' "${PIP_INDEX_URL}" > /etc/pip.conf; \
    python3 -m pip --version

# ==== Python libraries the skills share ======================================
# A skill's scripts run the way its SKILL.md says, usually as `python3 <skill>/scripts/x.py`.
# The signal-discovery skill needs the MCAP reader and Protobuf, so the system Python
# carries them and every Session finds them without installing anything.
#
# A project keeps its own dependencies apart: a virtual environment created with
# `python3 -m venv` does not see these packages unless it is made with
# `--system-site-packages`, so a project that pins another `protobuf` installs its own
# copy and is unaffected.
ARG SKILL_MCAP_VERSION=1.6.0
ARG SKILL_PROTOBUF_VERSION=7.36.2
# ve-tos-cli is the TOS reader the data-access skill drives (`ve-tos-cli` on PATH).
ARG TOS_CLI_VERSION=1.0.2
RUN set -eux; \
    python3 -m pip install --no-cache-dir --break-system-packages -i "${PIP_INDEX_URL}" \
        "mcap==${SKILL_MCAP_VERSION}" "mcap-protobuf-support==0.6.0" "protobuf==${SKILL_PROTOBUF_VERSION}" \
        "ve-tos-cli==${TOS_CLI_VERSION}"; \
    python3 -c 'import mcap, google.protobuf; print("skill libraries ok")'; \
    ve-tos-cli --help >/dev/null && echo "ve-tos-cli ok"

# ==== Python toolchain check =================================================
# Workers develop Python projects; these are the libraries that need compiling on
# musl and do not on glibc. A clean virtual environment proves the toolchain works
# without a compiler, so a later failure is a project problem, not the base image's.
RUN set -eux; \
    python3 -m venv /tmp/check-venv; \
    /tmp/check-venv/bin/pip install -q --no-cache-dir -i "${PIP_INDEX_URL}" lz4==4.4.5 zstandard==0.25.0; \
    /tmp/check-venv/bin/python -c 'import lz4, zstandard; print("python wheels ok")'; \
    rm -rf /tmp/check-venv

# The smoke test is part of the image so a base build can be checked in one command:
#   docker build -f docker/base/Dockerfile -t dsh-superagent-base:bookworm docker/base
#   docker run --rm --entrypoint sh dsh-superagent-base:bookworm /usr/local/bin/base-verify
COPY verify.sh /usr/local/bin/base-verify
RUN chmod +x /usr/local/bin/base-verify

# The application image runs as this user.
RUN set -eux; \
    groupadd --gid 1000 node 2>/dev/null || true; \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash node 2>/dev/null || true; \
    install -d -o node -g node /home/node/.config /home/node/.local

WORKDIR /home/node
