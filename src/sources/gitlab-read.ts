/** Read-only GitLab issue, merge request, note and pipeline inspection for assessments and workers. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import { isHumanUser, IssueSchema, MergeRequestSchema, NoteSchema, PipelineSchema } from './gitlab-trigger.ts'
import type { ContextMessage } from './kind.ts'

/** One note as a model-facing message; a system note is GitLab's own bookkeeping, never a person's words. */
const noteMessage = (note: z.infer<typeof NoteSchema>): ContextMessage => ({
  id: String(note.id), from: note.author.username, at: note.updated_at ?? note.created_at ?? '', text: note.body ?? '',
  ...isHumanUser(note.author) ? {} : { bot: true as const }, ...note.system === true ? { bot: true as const } : {},
})
/** A pipeline's state as the fact a Thread shows; changed failures stand out. */
export function pipelineFact(status: string | null | undefined): ThreadFact {
  if (!status) return { label: 'CI', value: { zh: '未知', en: 'unknown' } }
  const failed = status === 'failed' || status === 'canceled'
  const running = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running'].includes(status)
  if (failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: status, problem: true }
  if (running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: status }
  return { label: 'CI', value: status }
}
/** The label of the merge request's head pipeline, for a summary line. */
const pipelineLine = (mr: z.infer<typeof MergeRequestSchema>): string =>
  mr.head_pipeline ? `Pipeline ${mr.head_pipeline.status} at ${mr.sha?.slice(0, 7) ?? mr.head_pipeline.sha?.slice(0, 7) ?? ''}` : 'No pipeline'

/**
 * Reads a GitLab issue or merge request, a page of its notes, or its head pipeline, as model-facing
 * `{ id, from, at, text, bot? }` messages rather than raw API records.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|pipeline)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid> or gitlab/merge_requests/<iid>, or append /notes/<page> or /pipeline')
  const [, kind, iid, section, page = '1'] = match
  const mr = kind === 'merge_requests'
  if (section === 'pipeline') {
    if (!mr) throw new Error('Pipelines require a merge request')
    const item = MergeRequestSchema.parse(JSON.parse(await commands.gitlab(['api', 'GET', `projects/:id/merge_requests/${iid}`])))
    if (!item.head_pipeline) return { pipeline: null }
    const pipeline = PipelineSchema.parse(JSON.parse(await commands.gitlab(['api', 'GET', `projects/:id/pipelines/${item.head_pipeline.id}`])))
    return { pipeline: { id: pipeline.id, status: pipeline.status, sha: pipeline.sha, url: pipeline.web_url ?? null } }
  }
  if (!section) {
    if (mr) {
      const item = MergeRequestSchema.parse(JSON.parse(await commands.gitlab(['api', 'GET', `projects/:id/merge_requests/${iid}`])))
      return { number: item.iid, title: item.title, state: item.state, source_branch: item.source_branch,
        ...item.merge_when_pipeline_succeeds ? { auto_merge: true } : {}, ...pipelineLine(item) ? { pipeline: pipelineLine(item) } : {},
        ...noteMessage({ ...item, body: `${item.title}\n\n${item.description ?? ''}`, noteable_iid: item.iid, noteable_type: 'MergeRequest',
          created_at: item.created_at, author: item.author, id: item.iid, system: false, updated_at: item.updated_at }) }
    }
    const item = IssueSchema.parse(JSON.parse(await commands.gitlab(['api', 'GET', `projects/:id/issues/${iid}`])))
    return { number: item.iid, title: item.title, state: item.state,
      ...noteMessage({ ...item, body: `${item.title}\n\n${item.description ?? ''}`, noteable_iid: item.iid, noteable_type: 'Issue',
        created_at: item.created_at, author: item.author, id: item.iid, system: false, updated_at: item.updated_at }) }
  }
  const path = `projects/:id/${mr ? 'merge_requests' : 'issues'}/${iid}/notes?per_page=20&sort=desc&order_by=created_at&page=${page}`
  const listed = z.array(z.unknown()).parse(JSON.parse(await commands.gitlab(['api', 'GET', path])))
  const notes = listed.flatMap(item => { const parsed = NoteSchema.safeParse(item); return parsed.success ? [parsed.data] : [] })
  return { messages: notes.filter(note => note.system !== true).map(noteMessage), ...listed.length === 20 ? { next_resource: `gitlab/${kind}/${iid}/notes/${Number(page) + 1}` } : {},
    ...listed.length > notes.length ? { skipped: listed.length - notes.length } : {} }
}
/** The pipeline line a card shows for a merge request, or an empty string when GitLab reports none. */
export const mergePipelineLine = (mr: z.infer<typeof MergeRequestSchema>): string => pipelineLine(mr)
/** The ids of a page of notes, in the order GitLab listed them. */
export const noteIds = (notes: readonly z.infer<typeof NoteSchema>[]): string[] => notes.map(note => String(note.id))
/** Reads a non-hidden file or directory listing from the project's default branch through the GitLab repository API. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const filePath = encodeURIComponent(parts.join('/'))
  if (kind === 'directory') {
    const listing = z.array(z.looseObject({ name: z.string(), type: z.string(), path: z.string() }))
      .parse(JSON.parse(await commands.gitlab(['api', 'GET', `projects/:id/repository/tree?path=${filePath}&per_page=100`])))
    return listing.filter(item => !item.name.startsWith('.') && item.name !== 'node_modules')
      .map(item => `${item.type === 'tree' ? 'dir ' : 'file'} ${item.path}`).join('\n')
  }
  const file = z.looseObject({ content: z.string() })
    .parse(JSON.parse(await commands.gitlab(['api', 'GET', `projects/:id/repository/files/${filePath}?ref=${encodeURIComponent(await defaultBranch(commands))}`])))
  return Buffer.from(file.content, 'base64').toString('utf8')
}
/** The project's default branch, read once per call; GitLab's repository API requires it as `ref`. */
async function defaultBranch(commands: Commands): Promise<string> {
  const project = z.looseObject({ default_branch: z.string().nullish() })
    .parse(JSON.parse(await commands.gitlab(['api', 'GET', 'projects/:id'])))
  return project.default_branch ?? 'main'
}
/** The deployment's GitLab instance and project, for callers that build repository paths. */
export const projectOf = (deployment: Deployment): { host: string; project: string } | undefined =>
  deployment.gitlab ? { host: deployment.gitlab.host, project: deployment.gitlab.project } : undefined
