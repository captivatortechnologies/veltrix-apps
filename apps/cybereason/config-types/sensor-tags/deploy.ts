import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage, type CybereasonSession } from '../../lib/cybereasonApi'
import {
  TAGGING_ENDPOINT,
  SENSORS_QUERY_ENDPOINT,
  buildTagOps,
  buildProcessTagsBody,
  assertTagsApplied,
  sensorsFromResponse,
  buildPylumIdQuery,
  extractTagSnapshot,
  type TagSnapshot,
} from './_shared'

/**
 * Deploy Cybereason sensor tags over the REST API:
 *   read (rollback snapshot): POST /rest/sensors/query  filtered by pylumId
 *   write:                    POST /rest/tagging/process_tags
 *
 * process_tags IS an upsert per tag (SET or REMOVE) — the pylumId is the stable
 * identity. rollbackData records, per sensor, the prior tag snapshot (each field
 * null when it had no value before) so rollback can restore the exact prior
 * values or clear a tag that had none.
 */
async function readSnapshot(session: CybereasonSession, pylumId: string): Promise<TagSnapshot | null> {
  try {
    const res = await session.postJson(SENSORS_QUERY_ENDPOINT, buildPylumIdQuery(pylumId))
    if (!res.ok || looksLikeLoginPage(res.body)) return null
    return extractTagSnapshot(sensorsFromResponse(res.body), pylumId)
  } catch {
    return null
  }
}

interface PreviousTagSet {
  pylumId: string
  prior: TagSnapshot | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for sensor-tag deployment' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  const previous: PreviousTagSet[] = []
  const applied: string[] = []

  try {
    const session = await createSession(base, credential, timeoutMs)

    for (const item of items) {
      const pylumId = String(item.fields.pylumId ?? '').trim()
      if (!pylumId) continue

      const prior = await readSnapshot(session, pylumId)
      const ops = buildTagOps(item.fields)

      const res = await session.postJson(TAGGING_ENDPOINT, buildProcessTagsBody(pylumId, ops))
      if (!res.ok || looksLikeLoginPage(res.body)) {
        throw new Error(`tagging/process_tags → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
      }
      assertTagsApplied(res.body, pylumId)

      previous.push({ pylumId, prior })
      applied.push(pylumId)
    }

    return {
      success: true,
      message: `Applied tags to ${applied.length} sensor(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sensor-tag deploy failed after ${applied.length} item(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
