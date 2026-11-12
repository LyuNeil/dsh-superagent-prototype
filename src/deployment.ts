/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub or GitLab Source', branchPrefix: 'in the prepare command of the Execution settings',
  github: 'on the GitHub Source', gitlab: 'on the GitLab Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/**
 * GitLab Source fields setup reads. `host` is the instance root, `project` the `group/project` path, and `tokenFile` an
 * absolute path to a personal access token with `api` scope; the token is read at setup and never kept in settings.
 */
export const GitlabAccountsSchema = z.object({
  host: z.string().trim().regex(/^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?)?$/, 'https://host').default(''),
  project: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'group/project').default(''),
  tokenFile: z.string().trim().regex(/^(\/[^\0]*)?$/, 'absolute path').default(''),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape), gitlab: Object.keys(GitlabAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape),
}

export interface GithubAccount { cli: string; login: string; noreply: string }
export interface GitlabAccount { host: string; project: string; token: string; login: string; userId: number; noreply: string; defaultBranch: string }
export interface Deployment extends Machine {
  /** The repository the agent works on: `owner/name` on GitHub, `group/project` on GitLab. */
  repository: string
  /** The git host whose Source resolved `repository`; absent means GitHub, as before GitLab support existed. */
  git?: 'github' | 'gitlab'
  github?: GithubAccount
  gitlab?: GitlabAccount
  feishu?: FeishuBot
}
/** The git host a deployment works on; a deployment without GitLab and without an explicit `git` works on GitHub. */
export const gitHost = (deployment: Pick<Deployment, 'git' | 'gitlab'>): 'github' | 'gitlab' => deployment.git ?? (deployment.gitlab ? 'gitlab' : 'github')
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The GitHub account of a deployment; throws when the deployment runs on GitLab. */
export function githubOf(deployment: Deployment): GithubAccount {
  if (!deployment.github) throw new Error('This installation has no GitHub account; it works on GitLab')
  return deployment.github
}
/** The GitLab account of a deployment; throws when the deployment runs on GitHub. */
export function gitlabOf(deployment: Deployment): GitlabAccount {
  if (!deployment.gitlab) throw new Error('This installation has no GitLab account; it works on GitHub')
  return deployment.gitlab
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/**
 * Resolve which git host this installation works on. A GitLab project and token take precedence; GitHub follows.
 * @throws SetupError naming the Source card that still needs a value.
 */
export async function resolveDeployment(machine: Machine, sources: { github?: unknown; gitlab?: unknown }, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const gitlab = GitlabAccountsSchema.parse(sources.gitlab ?? {})
  const github = GithubAccountsSchema.parse(sources.github ?? {})
  if (gitlab.project || gitlab.host || gitlab.tokenFile) {
    if (gitlab.project && gitlab.host && gitlab.tokenFile) {
      const account = await resolveGitlab(machine, gitlab)
      return { ...machine, repository: account.project, git: 'gitlab', gitlab: account }
    }
    throw new SetupError(gitlab.project ? 'gitlabIncomplete' : 'gitlabUnset')
  }
  // Neither Source names a repository: the message names both, since either can satisfy setup.
  if (!github.repository) throw new SetupError('gitlabUnset')
  return resolveGithub(machine, github, probe, path)
}

/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveGithub(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, git: 'github',
    github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const GitlabUser = z.object({ username: z.string().min(1), id: z.number().int().positive() })
const GitlabProject = z.object({
  path_with_namespace: z.string().min(1), default_branch: z.string().nullable().optional(),
  permissions: z.object({ project_access: z.object({ access_level: z.number() }).nullish(), group_access: z.object({ access_level: z.number() }).nullish() }).nullish(),
})
/** Developer access level, the lowest that may push and open merge requests. */
const DEVELOPER = 30
/**
 * Read and verify a GitLab account: the token file names a token for `host`, the token's user may push to `project`.
 * The token stays in the returned deployment and is never written to logs or settings.
 */
export async function resolveGitlab(machine: Machine, config: unknown): Promise<GitlabAccount> {
  const { host, project, tokenFile } = GitlabAccountsSchema.parse(config ?? {})
  if (!host) throw new SetupError('gitlabHostUnset')
  if (!project) throw new SetupError('gitlabProjectUnset')
  if (!tokenFile) throw new SetupError('gitlabTokenUnset')
  let token: string
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch (error) { throw new SetupError('gitlabTokenUnreadable', { file: tokenFile, output: reason(error) }) }
  if (!token) throw new SetupError('gitlabTokenEmpty', { file: tokenFile })
  const base = host.replace(/\/+$/, '')
  const user = await examine(gl(base, token, 'user'), GitlabUser, () => new SetupError('gitlabTokenInvalid', { output: '' }))
  const details = await examine(gl(base, token, `projects/${encodeURIComponent(project)}`), GitlabProject,
    error => new SetupError('gitlabProjectUnreadable', { project, output: reason(error) }))
  const access = [details.permissions?.project_access?.access_level, details.permissions?.group_access?.access_level].filter((level): level is number => typeof level === 'number')
  const level = access.length ? Math.max(...access) : 0
  if (level < DEVELOPER) throw new SetupError('gitlabReadOnly', { project, account: user.username })
  return { host: base, project: details.path_with_namespace, token, login: user.username, userId: user.id,
    noreply: `${user.id}+${user.username}@users.noreply.${new URL(base).hostname}`, defaultBranch: details.default_branch ?? 'main' }
}
/** Awaits one GitLab read and validates its shape, so setup quotes a meaningful message instead of a schema failure. */
async function examine<T>(request: Promise<unknown>, schema: z.ZodType<T>, failure: (error: unknown) => SetupError): Promise<T> {
  let value: unknown
  try { value = await request } catch (error) { throw failure(error) }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw failure(new Error(parsed.error.issues.map(issue => issue.message).join('; ')))
  return parsed.data
}
/** One GitLab API v4 request; returns parsed JSON and turns HTTP failures into messages the setup problems quote. */
async function gl<T = unknown>(host: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${host}/api/v4/${path}`, { ...init,
    headers: { 'PRIVATE-TOKEN': token, accept: 'application/json', ...init?.body ? { 'content-type': 'application/json' } : {}, ...init?.headers } })
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} answered ${response.status} ${response.statusText}`.trim())
  return await response.json() as T
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}