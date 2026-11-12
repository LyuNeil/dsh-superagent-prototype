/** Normalizes GitLab issues, merge requests, notes and pipeline events into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'
import type { GitlabAccount } from '../deployment.ts'

export const SOURCE = 'gitlab'
/** GitLab reply address: an issue's or merge request's discussion, keyed by the issue's `iid` inside the project. */
export const gitlabChannel = (iid: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `gitlab:${iid}`, address: { iid: String(iid), ...(url ? { url } : {}) } })
/** The web page of an issue (`kind: 'issue'`) or merge request (`kind: 'mr'`). */
export const gitlabPage = (host: string, project: string, iid: number, kind: 'issue' | 'mr'): string =>
  `${host}/${project}/${kind === 'mr' ? '-/merge_requests' : '-/issues'}/${iid}`
/** Parses a project issue or merge request URL; returns undefined for another project or host. */
export function gitlabAddress(url: string, host: string, project: string): { iid: number; mr: boolean } | undefined {
  const pattern = new RegExp(`^${escapeRegExp(host)}/${escapeRegExp(project)}/-/(issues|merge_requests)/(\\d+)(?:[#/?].*)?$`)
  const match = pattern.exec(url)
  return match ? { iid: Number(match[2]), mr: match[1] === 'merge_requests' } : undefined
}
/** A GitLab user; deleted accounts arrive as `null`. */
export const UserSchema = z.looseObject({ username: z.string().min(1), id: z.number().int().positive(), bot: z.boolean().optional(), name: z.string().optional() })
  .nullable().transform(user => user ?? { username: 'ghost', id: 0 })
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), noteable_iid: z.number().nullish(), noteable_type: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** A merge request as `projects/:id/merge_requests/<iid>` returns it. */
export const MergeRequestSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  web_url: z.string(), author: UserSchema, created_at: z.string().nullish(), updated_at: z.string().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  source_branch: z.string(), target_branch: z.string().optional(), sha: z.string().nullish(),
  merge_when_pipeline_succeeds: z.boolean().nullish(), detailed_merge_status: z.string().nullish(),
  head_pipeline: z.looseObject({ id: z.number(), status: z.string(), sha: z.string().nullish(), web_url: z.string().nullish() }).nullish(),
})
export type MergeRequest = z.infer<typeof MergeRequestSchema>
/** An issue as `projects/:id/issues/<iid>` returns it. */
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(), web_url: z.string(), author: UserSchema,
  created_at: z.string(), updated_at: z.string().nullish(),
})
export type GitlabIssue = z.infer<typeof IssueSchema>
/** A pipeline as `projects/:id/pipelines/<id>` returns it, with the commit it ran on. */
export const PipelineSchema = z.looseObject({
  id: z.number(), status: z.string(), ref: z.string().optional(), sha: z.string(), web_url: z.string().nullish(),
  updated_at: z.string().nullish(),
})

/** GitLab marks service accounts with `bot: true`; a group or project access token acts as its owner. */
export const isHumanUser = (user: { username: string; bot?: boolean }): boolean => user.bot !== true && !/^project_\d+_bot/.test(user.username)
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_@])@${escapeRegExp(username)}(?![A-Za-z0-9_-])`, 'i').test(text)
const author = (user: { username: string; bot?: boolean }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanUser(user) && user.username !== agent })
/** An issue's or merge request's description becomes one Trigger; its ID is stable across edits of other fields. */
export function issueTrigger(issue: GitlabIssue, agent: string, kind: 'issue' | 'mr', url: string): Trigger {
  const text = `${issue.title}\n\n${issue.description ?? ''}`
  return { id: key(`gitlab-${kind}`, String(issue.iid)), source: SOURCE, threads: [{ source: SOURCE, id: String(issue.iid) }],
    ...author(issue.author, agent), at: issue.created_at, text,
    ...(mentions(issue.description ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(issue.iid, url), url, meta: { iid: issue.iid, kind } }
}
/**
 * A note on an issue or merge request. `version` participates in the ID so an edited note is a new Trigger while a reread
 * of the same note is not.
 */
export function noteTrigger(note: GitlabNote, iid: number, kind: 'issue' | 'mr', agent: string, url: string): Trigger {
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  return { id: key('gitlab-note', String(iid), String(note.id), at), source: SOURCE, threads: [{ source: SOURCE, id: String(iid) }],
    ...author(note.author, agent), at, text: note.body ?? '',
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(iid, url), url, meta: { iid, kind, noteId: note.id } }
}
/** A merge request opened or updated after a ticket was cut; it carries no channel because only the MR page reflects it. */
export function mergeRequestTrigger(mr: MergeRequest, agent: string, url: string, revision: number): Trigger {
  const text = `${mr.title}\n\n${mr.description ?? ''}`
  return { id: key('gitlab-mr', String(mr.iid), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(mr.iid) }],
    ...author(mr.author, agent), at: mr.created_at ?? new Date().toISOString(), text,
    ...(mentions(mr.description ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(mr.iid, url), url, meta: { iid: mr.iid, kind: 'mr', mrAuthor: mr.author.username, revision,
    ...mr.target_branch ? { targetBranch: mr.target_branch } : {} } }
}
/** A pipeline status change on a merge request's head or the default branch; CI has no person to address. */
export function pipelineTrigger(scope: { iid?: number; branch: string }, pipeline: { id: number; status: string; sha: string; web_url?: string | null },
  summary: string, url: string): Trigger {
  const thread = scope.iid === undefined ? `ci:${scope.branch}` : String(scope.iid)
  return { id: key('gitlab-pipeline', String(pipeline.id), pipeline.status), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary, url,
    meta: { ci: true, branch: scope.branch, sha: pipeline.sha, pipelineId: pipeline.id, revision: pipeline.id, ...scope.iid === undefined ? {} : { iid: scope.iid, kind: 'mr' } } }
}
/** Where a note lives, and whether it is on an issue or a merge request. */
export function noteTarget(note: GitlabNote): { iid: number; kind: 'issue' | 'mr' } | undefined {
  const iid = note.noteable_iid
  if (typeof iid !== 'number') return undefined
  return note.noteable_type === 'MergeRequest' ? { iid, kind: 'mr' } : note.noteable_type === 'Issue' ? { iid, kind: 'issue' } : undefined
}
/** A GitLab account's commit identity, derived from its numeric user id as GitLab's noreply domain expects. */
export const gitlabCommitEmail = (gitlab: GitlabAccount): string => gitlab.noreply