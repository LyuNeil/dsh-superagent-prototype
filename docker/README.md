# dsh-superagent in a container

This directory packages dsh-superagent as one long-running container service. It does
not change the project's design: the bundle still runs inside a DeepSeek Harness (DSH)
profile, workers still get one Session and one directory per Ticket, and settings still
come from the panel or the management API. The container supplies the machine around it:
Node, git, `gh`, tmux, Python, DSH itself, and a volume for everything that must survive
a restart.

## Two images: a base and the service

| Image | Built from | Rebuild when |
| --- | --- | --- |
| `dsh-superagent-base:bookworm` | `docker/base/Dockerfile` | the environment changes: a language toolchain, a CLI, a mirror, the OS |
| `dsh-superagent:local` | `docker/Dockerfile`, `FROM` the base | the bundle, its start-up script, or the `/data` layout changes |

The split exists because the environment is slow to build once (Debian packages, Node,
the GitHub CLI, lark-cli) and rarely changes, while the bundle changes often. Building the
base once means a bundle change rebuilds in a minute or two.

Build the base once:

```sh
docker build -f docker/base/Dockerfile -t dsh-superagent-base:bookworm docker/base
```

Then build the service as often as needed:

```sh
docker build -f docker/Dockerfile --build-arg BASE_IMAGE=dsh-superagent-base:bookworm -t dsh-superagent:local .
```

`docker-compose` uses `BASE_IMAGE=dsh-superagent-base:bookworm` by default, so the usual
`up -d --build` needs no flag.

The base image is Debian 12 (glibc), not Alpine: workers run arbitrary projects, and
glibc has the wheels and prebuilt binaries musl lacks — `lz4`, `zstandard`, `torch`,
`opencv`, Node native modules. Its apt, Node, pip and gh mirrors are build arguments, so
a network that reaches different mirrors overrides them:

| Argument | Default | For |
| --- | --- | --- |
| `DEBIAN_IMAGE` | the Volcengine Docker Hub mirror | a host that reaches Docker Hub directly |
| `APT_MIRROR`, `APT_SECURITY_MIRROR` | `mirrors.aliyun.com` | another Debian mirror |
| `NODE_MIRROR`, `NODE_VERSION` | `mirrors.aliyun.com/nodejs-release`, 24.19.0 | another Node mirror or version |
| `PIP_INDEX_URL` | `pypi.org/simple` | an internal PyPI mirror |
| `NPM_REGISTRY` | `registry.npmmirror.com` | an internal npm registry |
| `GH_MIRROR`, `GH_VERSION`, `GH_TARGET_ARCH` | `github.com/cli/cli/releases/download`, 2.60.0, `amd64` | another gh source, version or architecture |
| `LARK_CLI_VERSION` | 1.0.100 | another Feishu CLI version |

`gh` downloads at about 25 KB/s from GitHub on some networks, which alone adds ten
minutes to a base build. To keep it off the network, put the release tarball in
`docker/base/gh/` before building — the base uses it when it is there:

```sh
mkdir -p docker/base/gh
curl -fL -o docker/base/gh/gh_2.60.0_linux_amd64.tar.gz \
  https://github.com/cli/cli/releases/download/v2.60.0/gh_2.60.0_linux_amd64.tar.gz
docker build -f docker/base/Dockerfile -t dsh-superagent-base:bookworm docker/base
```

The same recipe works for any `GH_VERSION`: name the file
`gh_<version>_linux_amd64.tar.gz`.

## Quick start

```sh
cd <this checkout>
cp docker/.env.example docker/.env
$EDITOR docker/.env                          # model provider and its key

# Once, for the environment:
docker build -f docker/base/Dockerfile -t dsh-superagent-base:bookworm docker/base

docker-compose -f docker/docker-compose.yml up -d --build
docker-compose -f docker/docker-compose.yml logs -f
```

If `docker compose` is not a Docker CLI plugin on the host, the standalone
`docker-compose` binary runs the same file:

```sh
docker-compose -f docker/docker-compose.yml up -d --build
```

Docker Hub is unreachable from many Chinese networks. The base image names the Volcengine
Docker Hub mirror by default; pass `--build-arg DEBIAN_IMAGE=debian:12.12-slim` where
Docker Hub is reachable. The apt, Node and pip mirrors are arguments too.

The first start creates the `superagent` profile, writes its `cordis.patch.yml` into the
volume and installs the built bundle. When the log prints the panel URL, open
`http://127.0.0.1:<DSH_SUPERAGENT_PORT>/` on the Docker host and choose **Superagent** in
the sidebar.

The service starts even before setup succeeds: setup waits for the agent's GitHub
account, and the panel's Overview lists what is missing.

### GitLab: the token the agent acts with

Set `DSH_GIT_HOST=gitlab` in `docker/.env`; the entrypoint enables the GitLab Source
plugin in the profile. The agent acts as a token's user, so use a project access token or
a dedicated bot user's personal access token with the `api` scope and at least Developer
access to the project.

```sh
docker-compose -f docker/docker-compose.yml exec -u root superagent sh -c \
  "printf '%s\n' '<token>' > /data/secrets/gitlab-token && chown node:node /data/secrets/gitlab-token && chmod 600 /data/secrets/gitlab-token"
```

The token is read at startup and never written to settings, the database or the log. In
the panel, set the GitLab Source's host (`https://git.voyah.cn`), its project
(`<group>/<project>`, as the repository URL shows after the host) and its token file
(`/data/secrets/gitlab-token`). Saving checks the token's user and access level, then
restarts dsh-superagent.

### Feishu bot

Create a self-built app with the bot capability, grant it message events, chat read/send
and chat-member reads, and publish it. Then sign it in inside the container; `lark-cli`
keeps its own configuration under `/data`:

```sh
docker-compose -f docker/docker-compose.yml exec superagent \
  sh -c 'printf "%s" "$LARK_APP_SECRET" | lark-bot config init --app-id "$LARK_APP_ID" --app-secret-stdin'
docker-compose -f docker/docker-compose.yml exec superagent lark-bot config strict-mode bot --global
docker-compose -f docker/docker-compose.yml exec superagent lark-bot auth status
```

Set `LARK_APP_ID` and `LARK_APP_SECRET` in `docker/.env`, and keep the secret out of the
shell history: pass it on standard input as above. In the panel, set the Feishu Source's
CLI to `/usr/local/bin/lark-bot`, add the chats the bot should read, and save.

### GitHub (alternative)

With `DSH_GIT_HOST=github`, a GitHub CLI signed in to a dedicated agent account takes the
place of the token:

```sh
docker-compose -f docker/docker-compose.yml exec superagent \
  sh -c 'mkdir -p /data/gh && GH_CONFIG_DIR=/data/gh gh auth login'
docker-compose -f docker/docker-compose.yml exec superagent \
  sh -c 'GH_CONFIG_DIR=/data/gh gh api user --jq .login'
```

Then set the repository and the CLI (`/usr/local/bin/gh-agent`, which exports
`GH_CONFIG_DIR=/data/gh`) on the GitHub Source.

## Configuration

`docker/.env` is read by Compose and passed to the container.

| Variable | Meaning |
| --- | --- |
| `DSH_GIT_HOST` | `gitlab` or `github`; which Source plugin the profile enables |
| `DSH_LLM_PROVIDER`, `DSH_LLM_MODEL`, `DSH_LLM_BASE_URL` | The OpenAI-compatible provider every Session uses by default |
| `DSH_LLM_API_KEY_ENV`, `DSH_LLM_API_KEY` | The variable name the provider reads the key from, and the key |
| `DSH_SUPERAGENT_PORT` | The panel's port on the host's loopback, default 3082 |
| `REPO_CLONE` | Optional host clone mounted at `/repo` for the prepare command |
| `MEM_LIMIT`, `CPU_LIMIT` | Limits for the container |

The profile file (`/data/dsh/profiles/superagent/cordis.patch.yml` on the volume) is
rendered once from `docker/profile.patch.yml.template`. Edit it on the volume for
changes the environment does not cover; delete it to regenerate.

Everything else — Sources, Policy, Execution, Prompts — is configured in the panel, as
`docs/006-deployment.md` describes. None of it lives in the image.

## Host networking is required

The container runs with `network_mode: host`. DSH's web server refuses wildcard
addresses, and dsh-superagent's management API refuses any web server that is not bound
to `127.0.0.1`, then checks the `Host` header and grants panel-level permissions. A
published port (`-p`) cannot satisfy either check, so host networking is the only
mapping that keeps the panel reachable without weakening those checks.

The panel therefore listens on the Docker host's loopback only. Reach it from another
machine through an SSH tunnel:

```sh
ssh -L 3082:127.0.0.1:3082 <docker-host>
```

Do not put a reverse proxy in front of it that rewrites the `Host` header.

A worker can run any command as the container's user. For real isolation, run the
container on a dedicated host or VM: the container is the boundary, not the account
wrappers, exactly as `docs/006-deployment.md` describes.

## Operating it

```sh
docker-compose -f docker/docker-compose.yml ps
docker-compose -f docker/docker-compose.yml exec superagent dsh-superagent-status
docker-compose -f docker/docker-compose.yml logs -f --tail 200
docker-compose -f docker/docker-compose.yml restart
```

`dsh-superagent-status` reports the same four exit codes as `scripts/dsh-superagent
status` (0 normal, 1 down or runtime error, 2 a part reports an error, 3 setup waits).
The container's health check uses the same API: Docker marks the container unhealthy when
the runtime is not `ready` or `paused`.

The original `scripts/dsh-superagent` needs tmux and `ps` to find a service process,
which a container does not have; use Compose to start, stop and restart.

### State and backups

`/data` is the `superagent-data` volume:

| Path | Holds |
| --- | --- |
| `/data/dsh` | DSH profiles and Sessions |
| `/data/state` | `orchestrator.sqlite`, the lock, `worker-bin` shims, the worker git config |
| `/data/state/work` | Ticket directories, one checkout per Ticket (the Execution settings' default root) |
| `/data/secrets/gitlab-token` | The GitLab token file the GitLab Source reads |
| `/data/lark-cli` | The Feishu bot's `lark-cli` configuration |
| `/data/gh` | The agent account's `gh` credentials, on a GitHub deployment |
| `/data/.pnpm-store` | pnpm's store for the bundle install |

The service runs as uid 1000 (`node`), the only unprivileged account in the image;
workers inherit it and hold `danger-full-access` inside the container. A named volume is
created with that ownership. A bind mount keeps the host's ownership instead, so make it
writable first: `sudo chown -R 1000:1000 <host directory>`. The entrypoint refuses to
start otherwise, rather than failing later with a database error.

Back up `/data/state` before an upgrade, as `docs/006-deployment.md` says. A database
migrated by a newer version cannot be read by an older one.

```sh
docker run --rm -v dsh-superagent_superagent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/superagent-data.tgz -C /data state dsh
```

### Upgrade

```sh
git pull
docker-compose -f docker/docker-compose.yml build
docker-compose -f docker/docker-compose.yml up -d
```

The service image rebuilds from the base in seconds. Rebuild the base only when the
environment itself changes; see its build command above.

The image names itself after the bundle build, so `up -d` replaces the container and
reuses the volume. Running Assignments end with a recovery note and start again, as a
normal restart does.

The build runs `pnpm build` only. Run `pnpm check` (typecheck, tests, build) before
building an image you intend to run unattended.

## Python projects

A work item may be about a Python project, so the base image carries a Python toolchain a
worker can use without leaving the container:

| Piece | What it is |
| --- | --- |
| `python3`, `python3-pip`, `python3-venv` | Debian 12's Python 3.11 with `pip` and `venv` |
| `build-essential` | `gcc` and headers, for a project that compiles a C extension |
| `/etc/pip.conf` | The index from the base image's `PIP_INDEX_URL` |
| `/home/node/.config/pip/pip.conf` | The cache under `/data/.cache/pip` |

Debian's Python is a glibc build, so the usual manylinux wheels install without a
compiler, and a plain virtual environment is enough:

```sh
cd "$DSH_SUPERAGENT_DIR"
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m unittest discover -s tests -v
```

The prepare command in the Execution settings usually creates this virtual environment
once per work tree, so a worker only installs and tests. `build-essential` is there for
the projects that still need to compile something.

## How the pieces fit

| Piece | Where it comes from |
| --- | --- |
| `lib/` | Built in the `build` stage with `pnpm build` (typecheck and tests are separate: `pnpm check`) |
| DSH | `npm install -g @deepseek-ai/dsh@<DSH_VERSION>` in the service stage, on the base image |
| The bundle's runtime dependencies (`zod`, `proper-lockfile`) | `npm install --omit=dev` in the runtime stage, because `dsh plugin add link:` only creates a symlink |
| The profile | Created from DSH's `web` template on first start |
| The agent's GitLab token | `/data/secrets/gitlab-token`, read into memory at setup |
| The Feishu bot's CLI | `lark-bot`, a wrapper around `$LARKSUITE_CLI_CONFIG_DIR` (`/data/lark-cli`) |
| The environment (Node, git, gh, Python, build tools, lark-cli) | The base image, `docker/base/Dockerfile` |
| The Python toolchain | `python3`, `pip`, `venv` and `build-essential` from the base image |
| The panel | DSH's web server on `127.0.0.1:<port>` |

The bundle's worker and router presets live in `cordis.patch.yml`; the image copies it
next to `package.json`, so the profile installs them with the bundle.