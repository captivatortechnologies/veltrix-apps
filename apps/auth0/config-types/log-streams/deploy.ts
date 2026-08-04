import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  listAllPages,
} from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  buildLogStreamCreateBody,
  buildLogStreamUpdateBody,
  findLogStreamByName,
  snapshotLogStream,
  type Auth0LogStream,
  type LogStreamUpdateBody,
} from './_shared'

/**
 * Deploy Auth0 Log Streams over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/log-streams      → match by name
 *   create:                     POST /api/v2/log-streams        with name + type + sink (+ filters/status)
 *   update:                     PATCH /api/v2/log-streams/{id}  without name/type (immutable) — sink sent whole
 *
 * Upserts by NAME: list live log streams, PATCH one with the same name else
 * POST a new one. rollbackData records, per stream, the prior managed body
 * (null when it did not exist, secret sink keys stripped) AND the id — so
 * rollback restores the prior body or deletes the one we created.
 */
interface LogStreamSummary {
  id?: string
  name?: string
}

/** Read every live log stream (paginated) for name matching + rollback. */
async function listLogStreams(base: string, token: string): Promise<Auth0LogStream[]> {
  return listAllPages<Auth0LogStream>((page) => `${base}/log-streams?per_page=100&page=${page}`, token)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  const previous: Array<{ name: string; logStreamId: string | null; prior: LogStreamUpdateBody | null }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listLogStreams(base, accessToken)

    for (const item of items) {
      const name = readString(item.fields.name)
      if (!name) continue

      const existing = findLogStreamByName(live, name)
      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/log-streams/${encodeURIComponent(existing.id)}`, accessToken, buildLogStreamUpdateBody(item.fields))
        previous.push({ name, logStreamId: existing.id, prior: snapshotLogStream(existing) })
      } else {
        const created = await sendJson<LogStreamSummary>('POST', `${base}/log-streams`, accessToken, buildLogStreamCreateBody(item.fields))
        previous.push({ name, logStreamId: created?.id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} log stream(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 log stream deploy failed after ${applied.length} log stream(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
