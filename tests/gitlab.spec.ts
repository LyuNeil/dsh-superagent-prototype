import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { gitlabKind, pollProject, pollThreads as pollGitlabThreads } from '../src/sources/gitlab.ts'
import { claimMerge, mergeEndNotices, mergesOf, observeMerge, ticketBranch } from '../src/sources/gitlab-mr.ts'
import { gitlabAddress, gitlabChannel, issueTrigger, mergeRequestTrigger, noteTarget, noteTrigger, pipelineTrigger,
  type GitlabNote, type MergeRequest } from '../src/sources/gitlab-trigger.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { testDeployment } from './fixtures/deployment.ts'

const GITLAB = { host: 'https://git.example.com', project: 'team/widgets', token: 'secret-token', login: 'agent-bot', userId: 7,
  noreply: '7+agent-bot@users.noreply.git.example.com', defaultBranch: 'main' }
const deployment = testDeployment({ git: 'gitlab', gitlab: GITLAB, github: undefined, repository: 'team/widgets' })
let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gitlab-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A Source context over a real Store, with GitLab enabled and the agent allowed to originate work by name. */
function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = {}) {
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { gitlab: { enabled: true, config: { host: GITLAB.host, project: GITLAB.project, tokenFile: '/token', observeNotes: true, ...config } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { store, engine, commands, receive, ctx: sourceContextOf(deps, gitlabKind), health: board.all }
}
const note = (id: number, body: string, overrides: Partial<GitlabNote> = {}): GitlabNote => ({
  id, body, author: { username: 'alice', id: 1 }, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
  system: false, noteable_iid: 12, noteable_type: 'Issue', ...overrides,
})
const issue = (iid: number, overrides: Record<string, unknown> = {}) => ({ iid, title: 'Fix the margin', description: '@agent-bot please look',
  state: 'opened', web_url: `https://git.example.com/team/widgets/-/issues/${iid}`,
  author: { username: 'alice', id: 1 }, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', ...overrides })
const merge = (iid: number, overrides: Record<string, unknown> = {}): MergeRequest => ({ iid, title: 'Fix the margin', description: '',
  state: 'opened', web_url: `https://git.example.com/team/widgets/-/merge_requests/${iid}`, author: { username: 'agent-bot', id: 7 },
  created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z', source_branch: 'agent/fix-margin', target_branch: 'main',
  sha: 'abc', merge_when_pipeline_succeeds: false, ...overrides }) as MergeRequest
/** Answers `gitlab api GET <path>` from a route map; each route is a function so a page can change between polls. */
function routes(h: ReturnType<typeof host>, answers: Record<string, () => unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  // `Commands.gitlab` runs the packaged command by absolute path with the state
  // directory named; the mock records the API path (the third argument) and answers it.
  vi.spyOn(h.commands, 'gitlab').mockImplementation(async args => {
    const path = args[2]!
    reads.push(path)
    const route = Object.keys(answers).find(prefix => path.startsWith(prefix))
    if (!route) throw new Error(`no route for ${path}`)
    return JSON.stringify(answers[route]!())
  })
  return reads
}

describe('translation', () => {
  it('builds stable ids, threads, actors and addresses for issues, merge requests and notes', () => {
    const request = issueTrigger(issue(12), 'agent-bot', 'issue', 'https://git.example.com/team/widgets/-/issues/12')
    expect(request.id).toBe(key('gitlab-issue', '12'))
    expect(request.threads).toEqual([{ source: 'gitlab', id: '12' }])
    expect(request.actor).toEqual({ source: 'gitlab', id: 'alice' })
    expect(request.human).toBe(true)
    expect(request.addressed).toBe('mention')
    // A note's id includes the edit time, so an edit is a new Trigger while a reread is not.
    const earlier = noteTrigger(note(3, '@agent-bot fix it'), 12, 'issue', 'agent-bot', 'https://git.example.com/team/widgets/-/issues/12')
    const edited = noteTrigger(note(3, '@agent-bot fix it now', { updated_at: '2026-09-10T00:00:00Z' }), 12, 'issue', 'agent-bot', 'https://git.example.com/team/widgets/-/issues/12')
    expect(earlier.id).not.toBe(edited.id)
    expect(noteTrigger(note(3, '@agent-bot fix it'), 12, 'issue', 'agent-bot', 'https://git.example.com/team/widgets/-/issues/12')).toEqual(earlier)
    // The agent's own words are not a person's, and a system note never is.
    expect(noteTrigger(note(4, 'done', { author: { username: 'agent-bot', id: 7 } }), 12, 'issue', 'agent-bot', '').human).toBe(false)
    expect(noteTrigger(note(5, 'changed the description', { system: true }), 12, 'issue', 'agent-bot', '').actor.id).toBe('alice')
  })
  it('marks a ticket-owned branch and a merge request the agent opened', () => {
    const ticket = { execution: { name: 'fix-margin' } } as Ticket
    expect(ticketBranch(ticket, 'agent/fix-margin')).toBe(true)
    expect(ticketBranch(ticket, 'feature/margin')).toBe(false)
    expect(mergeRequestTrigger(merge(4), 'agent-bot', '', 1).meta).toMatchObject({ iid: 4, kind: 'mr', mrAuthor: 'agent-bot' })
  })
  it('parses project URLs and refuses another project', () => {
    expect(gitlabAddress('https://git.example.com/team/widgets/-/merge_requests/4', GITLAB.host, GITLAB.project)).toEqual({ iid: 4, mr: true })
    expect(gitlabAddress('https://git.example.com/team/other/-/issues/4', GITLAB.host, GITLAB.project)).toBeUndefined()
    expect(gitlabAddress('https://git.example.com/team/widgets/-/issues/9#note_1', GITLAB.host, GITLAB.project)).toEqual({ iid: 9, mr: false })
  })
  it('names the target of a note by the object it annotates', () => {
    expect(noteTarget(note(1, ''))).toEqual({ iid: 12, kind: 'issue' })
    expect(noteTarget(note(1, '', { noteable_type: 'MergeRequest' }))).toEqual({ iid: 12, kind: 'mr' })
    expect(noteTarget(note(1, '', { noteable_type: 'Commit' }))).toBeUndefined()
  })
})

describe('project streams', () => {
  it('stores each issue once and evaluates an allowed sender\'s mention as an explicit request', async () => {
    const h = host()
    routes(h, {
      'projects/:id/issues?': () => [issue(12)],
      'projects/:id/issues/12/notes': () => [],
      'projects/:id/merge_requests?': () => [],
    })
    // Turn the issue stream on: its first poll establishes the switch time, so the issue's older timestamp is in scope.
    h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), sources: { gitlab: { enabled: true,
      config: { ...h.store.settings().sources.gitlab!.config, observeIssues: true } } } }))
    const started = '2026-09-01T00:00:00.000Z'
    expect(await pollProject(h.ctx, new AbortController().signal, started, { skipped: 0 })).toEqual([])
    // The issue, and the opening description itself as a project note: both are the same message to Eval.
    expect(h.receive).toHaveBeenCalledTimes(1)
    const first = h.receive.mock.calls[0]![0]
    expect(first.id).toBe(key('gitlab-issue', '12'))
    expect(h.engine.candidate(first.id)?.strength).toBe('explicit')
    // A reread may offer the same issue again; its stable id makes the Engine store it once.
    await pollProject(h.ctx, new AbortController().signal, started, { skipped: 0 })
    expect(h.store.read.triggers({ source: 'gitlab' }, 0, 10).items.map(item => item.id)).toEqual([key('gitlab-issue', '12')])
    expect(h.store.get(KV.gitlab.stream('issues'))).toBeDefined()
  })
  it('takes in an issue\'s notes from someone other than the agent, and skips its own', async () => {
    // Issue 12 predates the switch, so it produces no Trigger of its own; its updated_at
    // still moved, which is how GitLab surfaces a comment (there is no project-wide notes endpoint).
    const h = host({}, { observeIssues: true, observeNotes: true })
    routes(h, {
      'projects/:id/issues?': () => [issue(12, { created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-09T00:00:00Z' })],
      'projects/:id/issues/12/notes': () => [note(9, '@agent-bot take this'), note(10, 'mine', { author: { username: 'agent-bot', id: 7 } })],
      'projects/:id/merge_requests?': () => [],
    })
    const started = '2026-09-01T00:00:00.000Z'
    expect(await pollProject(h.ctx, new AbortController().signal, started, { skipped: 0 })).toEqual([])
    // The person's note only; the agent's own note is skipped, and the old issue itself is not fresh.
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0].meta).toMatchObject({ iid: 12, kind: 'issue', noteId: 9 })
    // A second poll of the same object emits nothing: its note ids are recorded.
    h.receive.mockClear()
    await pollProject(h.ctx, new AbortController().signal, started, { skipped: 0 })
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('fails each stream independently and reports nothing for a lone failed poll', async () => {
    const h = host({}, { observeIssues: true })
    vi.spyOn(h.commands, 'run').mockRejectedValue(new Error('network down'))
    const failures = await pollProject(h.ctx, new AbortController().signal, new Date().toISOString(), { skipped: 0 })
    expect(failures.join()).toContain('issues')
    expect(h.receive).not.toHaveBeenCalled()
  })
})

describe('merge request rules', () => {
  it('binds the agent\'s merge request from the ticket\'s branch, and refuses another ticket\'s', () => {
    const h = host()
    h.store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'gitlab', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      origin: { triggerId: 'r1', triggerIds: [] }, execution: { name: 'fix-margin', directory: '/w/fix-margin', assignment: '' } })
    expect(claimMerge(h.ctx, 't1', merge(4))).toBeUndefined()
    expect(mergesOf(h.store.tickets.get('t1')!)).toEqual([4])
    h.store.tickets.save({ id: 't2', title: 'Other', decisionId: 'd2', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'gitlab', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      origin: { triggerId: 'r2', triggerIds: [] }, execution: { name: 'other', directory: '/w/other', assignment: '' } })
    expect(claimMerge(h.ctx, 't2', merge(4, { source_branch: 'feature/other', author: { username: 'someone', id: 3 } })))
      .toContain('does not belong to this ticket')
  })
  it('reports a merged merge request once to the tickets that follow it', () => {
    const h = host()
    h.store.threads.save({ key: 'gitlab:4', ref: { source: 'gitlab', id: '4' }, createdAt: '', subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
    const ticket = { id: 't1', follows: [{ thread: 'gitlab:4', own: true }] } as unknown as Ticket
    h.store.tickets.save({ ...ticket, title: 'Fix', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'gitlab', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      origin: { triggerId: 'r1', triggerIds: [] } })
    const closed = vi.spyOn(h.ctx.tickets, 'threadClosed')
    expect(observeMerge(h.ctx, merge(4, { state: 'merged', merged_at: '2026-09-10T00:00:00Z' }))).toBe(true)
    expect(closed).toHaveBeenCalledWith({ source: 'gitlab', id: '4' }, 'merged', '2026-09-10T00:00:00Z')
  })
  it('describes the end of a ticket\'s merge request in the request\'s language, for the other channels', () => {
    const ended = { id: 't1', ended: { outcome: 'merged', at: '', by: 'executor' },
      follows: [{ thread: 'gitlab:4', own: true, closed: { at: '2026-09-10T00:00:00Z', outcome: 'merged' } }],
      channels: [{ source: 'feishu', thread: 'feishu:oc_a:root', address: { chatId: 'oc_a', messageId: 'root' } },
        { source: 'gitlab', thread: 'gitlab:4', address: { iid: '4' } }] } as unknown as Ticket
    const notices = mergeEndNotices(ended, '修一下边距', deployment)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toBe('[MR !4](https://git.example.com/team/widgets/-/merge_requests/4) 已合并。')
    expect(notices[0]!.channel.source).toBe('feishu')
  })
})

describe('channel', () => {
  it('posts once, and finds its earlier note by marker on a retry', async () => {
    const h = host()
    const message = { id: 'm1', channel: gitlabChannel(12), text: 'Done', kind: 'reply' as const }
    const runs: string[][] = []
    vi.spyOn(h.commands, 'gitlab').mockImplementation(async args => {
      runs.push(args)
      return args[1] === 'GET' ? JSON.stringify([]) : '{}'
    })
    expect(await sendGitlab({ commands: h.commands }, message)).toBe('sent')
    expect(runs.at(-1)).toEqual(['api', 'POST', 'projects/:id/issues/12/notes', '--data', JSON.stringify({ body: 'Done\n\n<!-- dsh-superagent:m1 -->' })])
    vi.spyOn(h.commands, 'gitlab').mockImplementation(async args => args[1] === 'GET'
      ? JSON.stringify([{ id: 1, body: 'Done\n\n<!-- dsh-superagent:m1 -->', author: { username: 'agent-bot', id: 7 } }]) : '{}')
    expect(await sendGitlab({ commands: h.commands }, message)).toBe('sent')
  })
})

describe('threads and context', () => {
  it('reads a subscribed thread\'s new notes and the state of its merge request', async () => {
    const h = host()
    h.store.threads.save({ key: 'gitlab:4', ref: { source: 'gitlab', id: '4' }, createdAt: '', subscriptions: ['t1'], correlated: [],
      pending: [], meta: { kind: 'mr' } })
    routes(h, {
      'projects/:id/merge_requests/4/notes': () => [note(2, 'please rebase', { noteable_type: 'MergeRequest', noteable_iid: 4 })],
      'projects/:id/merge_requests/4': () => merge(4),
    })
    // A thread with a subscription but no ticket on the open list is not polled; the note still reaches it through a ticket.
    h.store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'gitlab', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      origin: { triggerId: 'r1', triggerIds: [] }, follows: [{ thread: 'gitlab:4', own: true }] })
    await pollGitlabThreads(h.ctx, new AbortController().signal, { skipped: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0].meta).toMatchObject({ iid: 4, kind: 'mr', noteId: 2 })
    // A second poll of the same page emits nothing: the note id was recorded.
    h.receive.mockClear()
    await pollGitlabThreads(h.ctx, new AbortController().signal, { skipped: 0 })
    expect(h.receive).not.toHaveBeenCalled()

  })
  it('reads a thread\'s description and notes for an assessment', async () => {
    const h = host()
    routes(h, {
      'projects/:id/issues/12/notes': () => [note(2, 'and the second one')],
      'projects/:id/issues/12': () => issue(12),
    })
    const trigger = issueTrigger(issue(12), 'agent-bot', 'issue', '')
    const config = gitlabKind.schema.parse({ host: GITLAB.host, project: GITLAB.project, tokenFile: '/token' })
    const root = await gitlabKind.threadContext!.read(h.commands, trigger, 'root', undefined, config)
    expect(root.messages[0]!.from).toBe('alice')
    const page = await gitlabKind.threadContext!.read(h.commands, trigger, 'thread', undefined, config)
    expect(page.messages).toEqual([{ id: '2', from: 'alice', at: '2026-09-09T00:00:00Z', text: 'and the second one' }])
  })
  it('gives a CI trigger its own message as context, with no thread response', async () => {
    const trigger = pipelineTrigger({ branch: 'main' }, { id: 5, status: 'failed', sha: 'abc' }, 'The main pipeline failed.', 'https://git.example.com/x')
    expect(trigger.threads).toEqual([{ source: 'gitlab', id: 'ci:main' }])
    expect(trigger.human).toBe(false)
    expect(trigger.id).toBe(key('gitlab-pipeline', '5', 'failed'))
  })
})