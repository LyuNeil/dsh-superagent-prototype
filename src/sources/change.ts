/**
 * The one place that knows whether the deployment's review unit is a GitHub pull request or a GitLab merge request.
 * Tickets, cards, tools and notices use these helpers so the rest of the application stays host-neutral.
 */
import type { Ticket } from '../core/index.ts'
import { gitHost, gitlabOf, type Deployment } from '../deployment.ts'
import { claimPull, pullOf, readPull, type Pull } from './github-pull.ts'
import { claimMerge, mergeOf } from './gitlab-mr.ts'
import { readMerge } from './gitlab.ts'
import type { SourceContext } from './host.ts'

/** The review unit a ticket follows: a PR on GitHub, an MR on GitLab. */
export interface Change { number: number; url: string; author: string; branch: string; state: 'open' | 'closed' | 'merged'; autoMerge: boolean }
/** The change a ticket follows, by number, on the deployment's git host. */
export const changeOf = (ticket: Pick<Ticket, 'follows'>, deployment: Pick<Deployment, 'git' | 'gitlab'>): number | undefined =>
  gitHost(deployment) === 'gitlab' ? mergeOf(ticket) : pullOf(ticket)
/** The field a report carries to bind the change: `mr_iid` on GitLab, `pr_number` on GitHub. */
export const changeField = (deployment: Pick<Deployment, 'git' | 'gitlab'>): 'mr_iid' | 'pr_number' =>
  gitHost(deployment) === 'gitlab' ? 'mr_iid' : 'pr_number'
/** Reads the change by number, or undefined when the host reports it gone. */
export async function readChange(ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Change | undefined> {
  if (gitHost(ctx.deployment) === 'gitlab') {
    const mr = await readMerge(ctx, number, signal ?? new AbortController().signal)
    return mr && { number: mr.iid, url: mr.web_url, author: mr.author.username, branch: mr.source_branch,
      state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open', autoMerge: mr.merge_when_pipeline_succeeds === true }
  }
  const pr: Pull = await readPull(ctx, number, signal)
  return { number: pr.number, url: pr.html_url, author: pr.user.login, branch: pr.head.ref, state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    autoMerge: pr.auto_merge != null }
}
/**
 * Reads a change and returns its claim, which binds it to the ticket. Reading happens before the caller's transaction, so a
 * network read never holds the database; the claim itself must run inside it, so a refused report also un-binds the change.
 */
export async function claimChange(ctx: SourceContext, ticketId: string, number: number, signal?: AbortSignal): Promise<{ claim(): string | undefined }> {
  if (gitHost(ctx.deployment) === 'gitlab') {
    const mr = await readMerge(ctx, number, signal ?? new AbortController().signal)
    return { claim: () => mr ? claimMerge(ctx, ticketId, mr) : `GitLab has no merge request !${number}` }
  }
  const pr = await readPull(ctx, number, signal)
  return { claim: () => claimPull(ctx, ticketId, pr) }
}
/** The project's repository path, and its web root, for links. */
export const projectOf = (deployment: Deployment): { host: string; project: string } =>
  gitHost(deployment) === 'gitlab' ? { host: gitlabOf(deployment).host, project: gitlabOf(deployment).project } : { host: 'https://github.com', project: deployment.repository }