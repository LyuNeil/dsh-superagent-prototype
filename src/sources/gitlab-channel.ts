/** GitLab outbound channel: posts notes on issues and merge requests as the token's user, once per message. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { gitlabOf } from '../deployment.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabAddress, gitlabChannel, gitlabPage, NoteSchema } from './gitlab-trigger.ts'

/** A note whose body carries this marker was queued by this message; a retried send finds it and does not post twice. */
export const noteMarker = (id: string): string => `<!-- dsh-superagent:${id} -->`
/** True when the project no longer accepts notes there: a missing or deleted issue/MR. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** The GitLab API path for an issue's or merge request's notes. */
const notesPath = (iid: number, kind: 'issue' | 'mr'): string =>
  `projects/:id/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`
/**
 * Posts `message` as a note on the issue or merge request it addresses. The marker makes the send idempotent: a note with
 * the same marker already on the conversation is not posted again.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { gitlab } = commands.deployment
  if (!gitlab) throw new Error('This installation has no GitLab account')
  const iid = Number(message.channel.address.iid)
  if (!iid) throw new Error('Missing GitLab reply target')
  const address = gitlabAddress(message.channel.address.url ?? '', gitlab.host, gitlab.project)
  const kind = address?.mr ? 'mr' : 'issue'
  const path = notesPath(iid, kind)
  const marker = noteMarker(message.id)
  try {
    const notes = z.array(NoteSchema).parse(JSON.parse(await commands.gitlab(['api', 'GET', `${path}?per_page=100&sort=desc`])))
    const mine = notes.some(note => note.author?.username === gitlab.login && (note.body ?? '').includes(marker))
    if (mine) return 'sent'
    const body = `${message.text}\n\n${marker}`
    await commands.gitlab(['api', 'POST', path, '--data', JSON.stringify({ body })])
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const iid = Number(address.iid ?? '')
  const url = address.url ?? (links.gitlab && iid ? gitlabPage(links.gitlab.host, links.gitlab.project, iid, 'issue') : '')
  return { url, label: { zh: `GitLab !${iid}`, en: `GitLab !${iid}` } }
}
/** The channel of a GitLab thread, for notices that name where they belong. */
export const channelOf = (iid: number, url?: string) => gitlabChannel(iid, url)