/** GitLab Source kind: a project's issues, merge requests, notes and pipelines, polled through the API v4. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { gitlabOf, GitlabAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { sendGitlab, gitlabLink } from './gitlab-channel.ts'
import { claimMerge, mergeOf, mergesOf, observeMerge } from './gitlab-mr.ts'
import { gitlabPage, IssueSchema, issueTrigger, MergeRequestSchema, mergeRequestTrigger, noteTrigger, NoteSchema, PipelineSchema,
  pipelineTrigger, SOURCE, type GitlabIssue, type GitlabNote, type MergeRequest } from './gitlab-trigger.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMerges: z.boolean().default(false), observeNotes: z.boolean().default(false),
  observePipelines: z.boolean().default(false),
  /** The branch a ticket's MR targets, such as the team's weekly branch; empty means the project's default branch. */
  targetBranch: z.string().trim().regex(/^[A-Za-z0-9._/-]*$/, 'a branch name, or empty for the default branch').default(''),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', merges: 'observeMerges', notes: 'observeNotes', pipelines: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
/** Which repository-wide stream a Trigger came from; the admission table's rows are these scopes. */
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'pipelines' : undefined
  if (meta.kind === 'note') return 'notes'
  if (meta.kind === 'mr') return meta.noteId !== undefined ? 'notes' : 'merges'
  return meta.kind === 'issue' ? 'issues' : undefined
}
/**
 * The Thread reader assessments use: the notes of an issue or merge request with the state of a merge request around them.
 * A page is the notes GitLab lists, oldest first, plus the issue or merge request body as the first message.
 */
export const gitlabThreadContext: NonNullable<SourceKind<GitlabConfig>['threadContext']> = {
  messageId: trigger => trigger.meta.noteId === undefined ? `${trigger.meta.kind}:${trigger.meta.iid}` : String(trigger.meta.noteId),
  async read(commands, trigger, part, cursor, config): Promise<{ messages: { id: string; from: string; at: string; text: string }[]; next?: string; body: Record<string, unknown> }> {
    void config
    const iid = Number(trigger.meta.iid)
    const kind = trigger.meta.kind === 'mr' ? 'mr' : 'issue'
    if (!iid) return { messages: [], body: {} }
    if (part === 'root' || part === 'parent') {
      // GitLab notes have no replies: the root of the conversation is the issue or MR description itself.
      const raw = await commands.gitlab(['api', 'GET', `projects/:id/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`])
      const body = JSON.parse(raw) as { title?: string; description?: string | null; author?: { username?: string }; created_at?: string }
      return { messages: [{ id: `${kind}:${iid}`, from: body.author?.username ?? '', at: body.created_at ?? '',
        text: `${body.title ?? ''}\n\n${body.description ?? ''}`.trim() }], body }
    }
    void cursor
    const path = `projects/:id/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes?per_page=100&sort=asc&order_by=created_at`
    const notes = z.array(NoteSchema).parse(JSON.parse(await commands.gitlab(['api', 'GET', path])))
    return { messages: notes.filter(note => note.system !== true).map(note => ({ id: String(note.id), from: note.author.username,
      at: note.updated_at ?? note.created_at ?? '', text: note.body ?? '' })), body: { notes: notes.length } }
  },
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；轮询项目里发给它的通知、已订阅 Issue 与 MR 的讨论、流水线状态变化和 MR 合并关闭。', en: 'The agent\'s GitLab account; polls notices to it in the project, discussion on subscribed Issues and MRs, pipeline changes, and MR merge or close.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: 'https://[A-Za-z0-9.\\-]+(:\\d+)?', label: { zh: 'GitLab 地址', en: 'GitLab host' },
      hint: { zh: '实例根地址，例如 https://git.voyah.cn。保存时用它和 token 校验项目，然后重启 dsh-superagent。', en: 'The instance root, such as https://git.voyah.cn. Saving checks the project with it and the token, then restarts dsh-superagent.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 group/project。这个来源接收这个项目的通知和讨论。', en: 'Written group/project. This Source receives this project\'s notices and discussion.' } },
    { key: 'tokenFile', type: 'text', pattern: '/.*', label: { zh: 'token 文件', en: 'Token file' },
      hint: { zh: '绝对路径，文件里是一个有 api 权限的 access token。token 只从这里读取，不写进设置或日志。', en: 'An absolute path to a file holding an access token with the api scope. The token is read only from here, never written to settings or logs.' } },
    { key: 'targetBranch', type: 'text', label: { zh: 'MR 的目标分支', en: 'MR target branch' },
      hint: { zh: '工单的分支从这个分支切出，MR 也合入它；留空用项目默认分支。填团队的周分支时，周分支不存在会在准备时自动创建。', en: 'A ticket branch starts from it and its merge request targets it; empty means the project default branch. When it names the team\'s weekly branch, a missing branch is created at prepare time.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on.' } },
    { key: 'observeMerges', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests' },
      hint: { zh: '打开后，没有 @ 智能体的新 MR 也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive notes in the project' },
      hint: { zh: '打开后，Issue 和 MR 上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。', en: 'Notes on Issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branch\'s pipelines' },
      hint: { zh: '打开后，默认分支流水线的失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s pipelines, and their recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: [SOURCE],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const iid = (/^!?(\d+)$/.exec(query.trim()) ?? /\/-?\/(?:merge_requests|issues)\/(\d+)/.exec(query))?.[1]
    return { threads: iid ? [`${SOURCE}:${iid}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose notes may become candidates' },
      hint: { zh: '名单里的账号（例如项目 access token 的账号）的评论在来源收到时成为推断的候选。它们不能发起明确的请求，也不能停止工单。', en: 'A note by an account on this list becomes an inferred candidate for an assessment when the Source receives it. Such an account never makes an explicit request or stops a ticket.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a note.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('merges', { zh: '新 MR', en: 'New merge requests' }),
        row('notes', { zh: '评论', en: 'Notes' }),
        // A pipeline has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'pipelines', label: { zh: '默认分支的流水线', en: 'Default branch pipelines' },
          note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', description: { zh: '这个来源监听的仓库，group/project。智能体在这里开的 MR，分支最后一段是 DSH_SUPERAGENT_NAME 时会关联到工单', en: 'The repository this Source watches, as group/project. An MR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；git 推送和 gitlab 命令都用这个 token', en: 'The agent\'s GitLab account. git push and the gitlab command both use this token' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或 MR 编号；工单不是从 GitLab 来的时为空', en: 'Number of the Issue or MR that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_TARGET_BRANCH', description: { zh: '工单的分支从哪个分支切出、MR 合入哪个分支：项目默认分支，或 source MR 的目标分支。准备命令和提示词都用它', en: 'The branch a ticket branch starts from and its merge request targets: the project default branch, or the source MR\'s target branch. The prepare command and the instructions both use it' } },
      { key: 'DSH_SUPERAGENT_GITLAB_CLONE_URL', description: { zh: '仓库的 clone 地址，https://<host>/<group>/<project>.git；准备命令用它拉取代码，凭据由 git 的 credential helper 提供', en: 'The repository clone URL, https://<host>/<group>/<project>.git. The prepare command clones from it; git\'s credential helper supplies the token' } },
    ],
    values: ({ deployment, trigger, config }) => {
      const account = deployment.gitlab
      const iid = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.iid) || 0 : 0
      // A ticket started from an MR merges back into that MR's target branch; otherwise
      // the Source's configured target branch (the team's weekly branch, say), else the
      // project's default branch.
      const target = trigger?.threads[0]?.source === SOURCE && typeof trigger.meta.targetBranch === 'string' && trigger.meta.targetBranch
        ? trigger.meta.targetBranch : config?.targetBranch || (account?.defaultBranch ?? '')
      return { DSH_SUPERAGENT_GITLAB_REPOSITORY: account?.project ?? '', DSH_SUPERAGENT_GITLAB_ACCOUNT: account?.login ?? '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: account?.noreply ?? '', DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_TARGET_BRANCH: target,
        DSH_SUPERAGENT_GITLAB_CLONE_URL: account ? `${account.host}/${account.project}.git` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    tokenFile: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // A failure escaping the loop would end the DSH process, so it is reported as the Source's health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** Reads a page of the project's notes for one issue or merge request, newest first. */
export async function readNotes(ctx: SourceContext, iid: number, kind: 'issue' | 'mr', signal: AbortSignal): Promise<GitlabNote[]> {
  const path = `projects/:id/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes?per_page=100&sort=desc&order_by=updated_at`
  const raw = await ctx.commands.withSignal(signal).gitlab(['api', 'GET', path])
  return z.array(z.unknown()).parse(JSON.parse(raw)).flatMap(item => { const parsed = NoteSchema.safeParse(item); return parsed.success ? [parsed.data] : [] })
}
/** Reads one merge request, or undefined when GitLab reports it gone. */
export async function readMerge(ctx: SourceContext, iid: number, signal: AbortSignal): Promise<MergeRequest | undefined> {
  try {
    return MergeRequestSchema.parse(JSON.parse(await ctx.commands.withSignal(signal).gitlab(['api', 'GET', `projects/:id/merge_requests/${iid}`])))
  } catch (error) { if (error instanceof CliError && error.code === 404) return undefined; throw error }
}
/** Reads one issue, or undefined when GitLab reports it gone. */
export async function readIssue(ctx: SourceContext, iid: number, signal: AbortSignal): Promise<GitlabIssue | undefined> {
  try {
    return IssueSchema.parse(JSON.parse(await ctx.commands.withSignal(signal).gitlab(['api', 'GET', `projects/:id/issues/${iid}`])))
  } catch (error) { if (error instanceof CliError && error.code === 404) return undefined; throw error }
}
/** What a Thread reader and the poller share: the project's web root for links. */
const pageUrl = (ctx: SourceContext, iid: number, kind: 'issue' | 'mr'): string => {
  const { host, project } = gitlabOf(ctx.deployment)
  return gitlabPage(host, project, iid, kind)
}
/** Lists the merge requests updated since `since`, oldest first. */
async function readMerges(ctx: SourceContext, since: string, signal: AbortSignal, tally: Tally): Promise<MergeRequest[]> {
  const raw = await ctx.commands.withSignal(signal).gitlab(['api', 'GET',
    `projects/:id/merge_requests?state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&per_page=100`])
  return validItems(MergeRequestSchema, z.array(z.unknown()).parse(JSON.parse(raw)), tally)
}
/** Lists the issues updated since `since`, oldest first. */
async function readIssues(ctx: SourceContext, since: string, signal: AbortSignal, tally: Tally): Promise<GitlabIssue[]> {
  const raw = await ctx.commands.withSignal(signal).gitlab(['api', 'GET',
    `projects/:id/issues?state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&per_page=100`])
  return validItems(IssueSchema, z.array(z.unknown()).parse(JSON.parse(raw)), tally)
}
/** A project-wide stream cursor: the newest `updated_at` read, stepped back five seconds for late writes. */
function advance(ctx: SourceContext, key: string, since: string, items: { updated_at?: string | null }[], started: string): string {
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  return Date.parse(moved) > Date.parse(since) ? moved : started
}
/**
 * Polls the project-wide streams switched on: issues, merge requests, notes on both, and the default branch's pipeline.
 * Each stream reads from when it was switched on and fails independently; a Trigger ID deduplicates overlaps.
 */
export async function pollProject(ctx: SourceContext, signal: AbortSignal, started: string, tally: Tally): Promise<string[]> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  const failures: string[] = []
  const login = gitlabOf(ctx.deployment).login
  const horizon = new Date(Date.parse(started) - POLL_HORIZON_MS).toISOString()
  if (!config) return failures
  // Issues and merge requests: a new one becomes a Trigger only when it was opened after the switch was on.
  for (const [id, observed, read] of [
    ['issues', config.observeIssues, readIssues] as const, ['merges', config.observeMerges, readMerges] as const]) {
    const key = KV.gitlab.stream(id)
    const stored = ctx.state.get(key)
    if (!observed) { ctx.state.set(key, undefined); continue }
    const since = new Date(Math.max(Date.parse(stored?.since ?? started), Date.parse(horizon))).toISOString()
    try {
      const items = await read(ctx, since, signal, tally)
      for (const item of items) {
        if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
        const isMerge = 'source_branch' in item
        // Its opening description becomes a Trigger only when a person opened it after the
        // switch was on; the agent's own issue is not a request. An older object still
        // carries comments that changed since, from someone other than the agent, so it is
        // read below even when its own description is skipped.
        const fresh = Date.parse(('created_at' in item ? item.created_at : '') ?? '') >= Date.parse(stored?.started ?? started)
        if (fresh && item.author.username !== login) {
          await ctx.receive(isMerge ? mergeRequestTrigger(item as MergeRequest, login, pageUrl(ctx, (item as MergeRequest).iid, 'mr'), item.iid)
            : issueTrigger(item as GitlabIssue, login, 'issue', pageUrl(ctx, (item as GitlabIssue).iid, 'issue')))
          describe(ctx, item.iid, item.title)
        }
        // GitLab has no project-wide notes endpoint; an issue or merge request whose
        // `updated_at` moved carries the comments that changed it, and its own notes
        // endpoint does exist. Reading them here keeps a comment from waiting for the
        // subscribed-Thread poll, which only covers Threads a Ticket already follows.
        if (config.observeNotes) await intakeNotes(ctx, item.iid, isMerge ? 'mr' : 'issue', login, signal)
      }
      ctx.state.set(key, { since: advance(ctx, key, since, items, started), started: stored?.started ?? started })
    } catch (error) { if (!signal.aborted) failures.push(`${id}: ${String(error)}`) }
  }
  // The default branch's pipeline: a Trigger only when the status changes after the first baseline.
  if (config.observePipelines) {
    try { failures.push(...await pollBranchPipeline(ctx, signal, login, started)) }
    catch (error) { if (!signal.aborted) failures.push(`default branch pipeline: ${String(error)}`) }
  } else ctx.state.set(KV.gitlab.branchPipeline, undefined)
  return failures
}
/**
 * Takes in the notes of one issue or merge request. GitLab has no project-wide notes endpoint, so a
 * comment is noticed through its object's `updated_at` and read from the object's own notes.
 * A note already taken in for that object is skipped, so a poll that repeats an object emits nothing.
 */
async function intakeNotes(ctx: SourceContext, iid: number, kind: 'issue' | 'mr', login: string, signal: AbortSignal): Promise<void> {
  const seenKey = KV.gitlab.threadSeen(`${SOURCE}:${iid}`)
  const seen = ctx.state.get(seenKey) ?? []
  for (const note of await readNotes(ctx, iid, kind, signal)) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
    if (note.author.username === login || note.system === true || seen.includes(note.id)) continue
    await ctx.receive(noteTrigger(note, iid, kind, login, pageUrl(ctx, iid, kind)))
    seen.push(note.id)
  }
  if (seen.length) ctx.state.set(seenKey, seen.slice(-200))
}

/** Polls the default branch's pipeline, emitting a Trigger when its status changes after the first baseline. */
async function pollBranchPipeline(ctx: SourceContext, signal: AbortSignal, login: string, started: string): Promise<string[]> {
  const { defaultBranch, host, project } = gitlabOf(ctx.deployment)
  const raw = await ctx.commands.withSignal(signal).gitlab(['api', 'GET',
    `projects/:id/pipelines?ref=${encodeURIComponent(defaultBranch)}&per_page=1&order_by=id&sort=desc`])
  const [pipeline] = validItems(PipelineSchema, z.array(z.unknown()).parse(JSON.parse(raw)))
  if (!pipeline) return []
  const previous = ctx.state.get(KV.gitlab.branchPipeline)
  const baseline = previous?.branch === defaultBranch ? previous.status : undefined
  const failures: string[] = []
  if (baseline !== undefined && baseline !== pipeline.status && ['failed', 'success'].includes(pipeline.status)) {
    const url = pipeline.web_url ?? gitlabPage(host, project, 0, 'issue')
    await ctx.receive(pipelineTrigger({ branch: defaultBranch }, pipeline, `The ${defaultBranch} pipeline is ${pipeline.status}.`, url))
  }
  ctx.state.set(KV.gitlab.branchPipeline, { branch: defaultBranch, status: pipeline.status })
  return failures
}
/** Publishes a Thread's display name and URL after a Trigger reaches it. */
function describe(ctx: SourceContext, iid: number, title: string): void {
  const { host, project } = gitlabOf(ctx.deployment)
  ctx.threads.describe(`${SOURCE}:${iid}`, { label: `GitLab !${iid}: ${title}`, url: gitlabPage(host, project, iid, 'issue') })
}
/** Polls subscribed threads (their notes, and a merge request's state) and reports the MR ends the core watches. */
export async function pollThreads(ctx: SourceContext, signal: AbortSignal, tally: Tally): Promise<void> {
  const login = gitlabOf(ctx.deployment).login
  let closed = false
  await pollEach(ctx, SOURCE, () => signal.aborted, async thread => {
    const iid = Number(thread.ref.id)
    if (!Number.isFinite(iid)) return
    const kind = thread.meta.kind === 'issue' ? 'issue' : 'mr'
    for (const note of await readNotes(ctx, iid, kind, signal)) {
      if (note.author.username === login || note.system === true) continue
      const at = note.updated_at ?? note.created_at ?? ''
      // Only notes newer than the last one this Source stored, so a poll that repeats a page emits nothing.
      if (ctx.state.get(KV.gitlab.threadSeen(thread.key))?.includes(note.id) !== true) {
        await ctx.receive(noteTrigger(note, iid, kind, login, pageUrl(ctx, iid, kind)))
        const seen = ctx.state.get(KV.gitlab.threadSeen(thread.key)) ?? []
        ctx.state.set(KV.gitlab.threadSeen(thread.key), [...seen.slice(-199), note.id])
      }
      void at
    }
    if (kind === 'mr') {
      const mr = await readMerge(ctx, iid, signal)
      if (mr && observeMerge(ctx, mr)) closed = true
    }
  })
  void closed
  void tally
}
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) {
        const started = new Date().toISOString()
        const tally: Tally = { skipped: 0 }
        const problems = await pollProject(ctx, signal, started, tally)
        await pollThreads(ctx, signal, tally)
        if (problems.length) throw new Error(problems.join('; '))
        ctx.report(SOURCE, { state: 'ready', detail: tally.skipped ? `${tally.skipped} unreadable item(s) skipped` : 'Polling the project', at: new Date().toISOString() })
      } else ctx.report(SOURCE, health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    await pause(Math.max(1, config?.pollSeconds ?? 60) * 1000, signal)
  }
}
export { mergeOf, mergesOf, claimMerge }