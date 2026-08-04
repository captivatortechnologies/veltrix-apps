import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildDecoratorBody, decoratorsFromList, findDecorator, resolveDecoratorStreamId, type GraylogDecorator } from './_shared'

/**
 * Deploy Graylog message decorators over the REST API:
 *   resolve: GET /api/streams                        → stream_title → stream id ('' = global)
 *   read (rollback): GET  /api/search/decorators       → find the live decorator by (stream, type)
 *   create:          POST /api/search/decorators        → Decorator { id, ... }
 *   update:          PUT  /api/search/decorators/{id}   → Decorator
 *
 * The (stream, type) PAIR is the identity this config type reconciles by (see
 * the module doc in _shared.ts). A declared stream_title that can't be
 * resolved fails that item's deploy loudly. rollbackData records, per
 * decorator, the prior decorator (null when it did not exist) AND its id — so
 * rollback can restore the prior config or delete the one we created.
 */
async function listDecorators(base: string, headers: Record<string, string>): Promise<GraylogDecorator[]> {
  try {
    return decoratorsFromList(await getJson<unknown>(`${base}/api/search/decorators`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for decorator deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ type: string; streamId: string; decoratorId: string | null; decorator: GraylogDecorator | null }> = []
  const applied: string[] = []

  try {
    const live = await listDecorators(base, headers)

    for (const item of items) {
      const type = asString(item.fields.type)
      if (!type) continue

      const streamTitle = asString(item.fields.stream_title)
      let streamId = ''
      if (streamTitle) {
        streamId = await resolveDecoratorStreamId(base, headers, streamTitle)
        if (!streamId) throw new Error(`Decorator "${type}": stream "${streamTitle}" was not found.`)
      }

      const { body, error } = buildDecoratorBody(item.fields, streamId)
      if (error || !body) throw new Error(`Decorator "${type}": ${error ?? 'could not build request body'}`)

      const existing = findDecorator(live, streamId, type)
      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/search/decorators/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ type, streamId, decoratorId: existing.id, decorator: existing })
      } else {
        const created = await sendJson<GraylogDecorator>('POST', `${base}/api/search/decorators`, headers, body)
        previous.push({ type, streamId, decoratorId: created?.id ?? null, decorator: null })
      }
      applied.push(`${type}${streamTitle ? ` (${streamTitle})` : ' (global)'}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} decorator(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Decorator deploy failed after ${applied.length} decorator(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
