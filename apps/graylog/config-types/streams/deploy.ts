import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { buildStreamBody, streamsFromList, findStream, resolveIndexSetId, type GraylogStream } from './_shared'

/**
 * Deploy Graylog streams over the REST API:
 *   read (rollback): GET  /api/streams              → find the live stream by title
 *   create:          POST /api/streams              → { stream_id }, then resume it
 *   resume:          POST /api/streams/{id}/resume  (streams are created paused)
 *   update:          PUT  /api/streams/{id}         (stream exists)
 *
 * The stream TITLE is the stable identity used to upsert. rollbackData records,
 * per stream, the prior stream body (null when it did not exist) AND the stream id
 * — so rollback can restore the prior body or delete the one we created.
 *
 * A new stream is created PAUSED by Graylog, so create is followed by a resume to
 * make it active. Verify the create response shape ({ stream_id }) against a live
 * Graylog instance.
 */
interface StreamCreateResponse {
  stream_id?: string
  id?: string
}

/** Read every live stream (best-effort) for identity matching + rollback snapshots. */
async function listStreams(base: string, headers: Record<string, string>): Promise<GraylogStream[]> {
  try {
    return streamsFromList(await getJson<unknown>(`${base}/api/streams`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for stream deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; streamId: string | null; stream: GraylogStream | null }> = []
  const applied: string[] = []

  try {
    const live = await listStreams(base, headers)

    for (const item of items) {
      const title = String(item.fields.title ?? '').trim()
      if (!title) continue

      const indexSetId = await resolveIndexSetId(base, headers, item.fields.index_set_id)
      const body = buildStreamBody(item.fields, indexSetId)
      const existing = findStream(live, title)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/streams/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ title, streamId: existing.id, stream: existing })
      } else {
        const created = await sendJson<StreamCreateResponse>('POST', `${base}/api/streams`, headers, body)
        const newId = created?.stream_id ?? created?.id ?? null
        if (newId) {
          // Graylog creates streams paused; resume so the stream actually routes.
          await sendJson('POST', `${base}/api/streams/${encodeURIComponent(newId)}/resume`, headers)
        }
        previous.push({ title, streamId: newId, stream: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} stream(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Stream deploy failed after ${applied.length} stream(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
