import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildXsoarClient,
  parseJsonValue,
  xsoarErrorMessage,
  type XsoarClient,
  type XsoarSearchEnvelope,
} from '../../lib/xsoar'
import { extractJobSpecs, type JobSpec, type LiveJob } from './validate'

export interface JobRollbackEntry {
  name: string
  existed: boolean
  /** Server id (needed to delete a created job / restore an updated one). */
  id?: string
  prior?: LiveJob
}

/**
 * Deploy XSOAR scheduled jobs via the server REST API.
 *
 * Identity is the job NAME. Search every job (POST /jobs/search), match on name,
 * then upsert with POST /jobs — merging the live job (id + version) on update so
 * XSOAR accepts the write, or creating fresh otherwise. A created job's id is
 * resolved from the save response (or a follow-up name search) so it can be rolled
 * back with DELETE /jobs/{id}.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, serverUrl } = built

  const specs = extractJobSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: JobRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await searchAllJobs(client)
    const byName = new Map(existing.filter((j) => j.name).map((j) => [j.name as string, j]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        await saveJob(client, spec, live)
      } else {
        const saved = await saveJob(client, spec, null)
        const id = saved?.id ?? (await resolveJobId(client, spec.name))
        rollbackState.push({ name: spec.name, existed: false, id })
        if (id) createdIds.push(id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} job(s) to ${serverUrl}: ${deployed.join(', ')}`,
      artifacts: { serverUrl, deployedJobs: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Job deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { serverUrl, deployedJobs: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Search every job, following the `total` count across pages. Throws on non-OK. */
export async function searchAllJobs(client: XsoarClient): Promise<LiveJob[]> {
  const size = 100
  const maxPages = 100
  const items: LiveJob[] = []
  for (let page = 0; page < maxPages; page++) {
    const res = await client.request('POST', '/jobs/search', { body: { page, size } })
    if (!res.ok) throw new Error(`Failed to search jobs: ${xsoarErrorMessage(res)}`)
    const env = parseJsonValue<XsoarSearchEnvelope<LiveJob>>(res.body).value
    const data = Array.isArray(env?.data) ? (env?.data as LiveJob[]) : []
    items.push(...data)
    const total = typeof env?.total === 'number' ? env.total : items.length
    if (data.length === 0 || items.length >= total) break
  }
  return items
}

/** Find a single job by exact name; returns null when absent. */
export async function searchJobByName(client: XsoarClient, name: string): Promise<LiveJob | null> {
  const res = await client.request('POST', '/jobs/search', {
    body: { page: 0, size: 1, query: `name:"${name}"` },
  })
  if (!res.ok) throw new Error(`Failed to search job "${name}": ${xsoarErrorMessage(res)}`)
  const env = parseJsonValue<XsoarSearchEnvelope<LiveJob>>(res.body).value
  const data = Array.isArray(env?.data) ? (env?.data as LiveJob[]) : []
  return data[0] ?? null
}

/** Resolve a job's server id by name (used right after a create). */
async function resolveJobId(client: XsoarClient, name: string): Promise<string | undefined> {
  const found = await searchJobByName(client, name)
  return found?.id
}

/**
 * Upsert one job via POST /jobs. On update, the live job is spread first so its
 * id + version travel with the write; the declared fields then overwrite the
 * managed ones. On create the job is sent fresh with `scheduled: true`.
 */
export async function saveJob(client: XsoarClient, spec: JobSpec, live: LiveJob | null): Promise<LiveJob | null> {
  const body: Record<string, unknown> = {
    ...(live ?? {}),
    name: spec.name,
    type: spec.type,
    playbookId: spec.playbookId ?? '',
    scheduled: true,
    recurrent: spec.recurrent,
    cron: spec.cron ?? '',
    tags: spec.tags,
    disabled: spec.disabled,
  }
  const res = await client.request('POST', '/jobs', { body })
  if (!res.ok) throw new Error(`Failed to save job "${spec.name}": ${xsoarErrorMessage(res)}`)
  return parseJsonValue<LiveJob>(res.body).value
}
