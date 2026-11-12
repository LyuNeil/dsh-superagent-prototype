/** Merge request binding, lifecycle observation, and auto-merge rules for the GitLab Source. */
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import { gitlabOf, type Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { gitlabPage, SOURCE, type MergeRequest } from './gitlab-trigger.ts'

/** A merge request as a Ticket follows it: the thread key is `gitlab:<iid>`. */
export const mrNumber = (thread: string): number | undefined =>
  thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined
export const mergesOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrNumber(item.thread) ?? [])
export const mergeOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mergesOf(ticket, true).at(-1) ?? mergesOf(ticket).at(-1)
/** True when the merge request came from the agent's own branch in the configured project, not a fork. */
export const agentMerge = (mr: Pick<MergeRequest, 'author' | 'source_branch'>, deployment: Deployment): boolean =>
  sameName(mr.author.username, gitlabOf(deployment).login)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
/** GitLab reports a merge request's readiness as `detailed_merge_status`, keyed by the head pipeline's state. */
const mergeStatus = (mr: MergeRequest): string | undefined => mr.detailed_merge_status ?? undefined

/**
 * Validates and binds an open merge request to a ticket when it is the ticket's origin MR or one the agent opened from the
 * ticket's branch, enforcing that one MR binds to at most one open ticket.
 * @returns an error message when binding is refused, or undefined when it is bound or when the MR is not open.
 */
export function claimMerge(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its merge request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.kind === 'mr' && source.meta.iid === mr.iid
  const opened = agentMerge(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const { login } = gitlabOf(ctx.deployment)
    return `The merge request does not belong to this ticket: use the source MR or one by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mergesOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'The merge request already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${mr.iid}`)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled merge request's state with the tickets that follow it or whose branch matches.
 * @returns whether the MR has ended (merged or closed).
 */
export function observeMerge(ctx: SourceContext, mr: MergeRequest): boolean {
  const ended = mr.state === 'merged' || mr.state === 'closed'
  if (ended) closeMerge(ctx, mr)
  else {
    const candidates = agentMerge(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${mr.iid}` && item.closed)
    if (ticket && (reopened || mergesOf(ticket, true).every(number => number === mr.iid))) claimMerge(ctx, ticket.id, mr)
  }
  ctx.threads.describe(`${SOURCE}:${mr.iid}`, { facts: { autoMerge: !ended && mr.merge_when_pipeline_succeeds ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: MergeRequest, own: boolean): void {
  const { host, project } = gitlabOf(ctx.deployment)
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: String(mr.iid) }, own)
    ctx.threads.patch(`${SOURCE}:${mr.iid}`, { iid: mr.iid, kind: 'mr', url: mr.web_url ?? gitlabPage(host, project, mr.iid, 'mr'), mrAuthor: mr.author.username })
  })
}
/** Reports a merged or closed MR once to the tickets that follow it; the core decides whether that ends them. */
function closeMerge(ctx: SourceContext, mr: MergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergesOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: String(mr.iid) }, mr.state === 'merged' ? 'merged' : 'closed', at)
}
/**
 * Whether the agent may enable auto-merge on this MR: it is open, the agent authored it, and no blocking check or
 * conflict stands in the way. GitLab then merges it once the pipeline succeeds.
 */
export function mayAutoMerge(mr: MergeRequest): { ok: true } | { ok: false; reason: string } {
  if (mr.state !== 'opened') return { ok: false, reason: `the merge request is ${mr.state}` }
  const status = mergeStatus(mr)
  if (status && ['cannot_be_merged', 'broken', 'draft', 'blocked_status'].includes(status)) return { ok: false, reason: `GitLab reports ${status}` }
  const pipeline = mr.head_pipeline?.status
  if (pipeline && ['failed', 'canceled'].includes(pipeline)) return { ok: false, reason: `the pipeline is ${pipeline}` }
  return { ok: true }
}
/**
 * Notices for the conversations of a ticket that ended with its merge request, selecting the last MR it opened if any,
 * else the last it followed. The notice language follows the request: Chinese when it has Han and no kana.
 */
export function mergeEndNotices(ticket: Ticket, request: string, deployment: Deployment): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const { host, project } = gitlabOf(deployment)
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = mrNumber(follow.thread)!
  const url = gitlabPage(host, project, iid, 'mr')
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  // The MR timeline already shows the merge; chat channels receive the one notice.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}