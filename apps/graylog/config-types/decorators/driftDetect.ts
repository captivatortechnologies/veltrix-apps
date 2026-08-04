import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, toInt, parseJsonObject } from '../../lib/coerce'
import { decoratorsFromList, findDecorator, resolveDecoratorStreamId } from './_shared'

/**
 * Drift for decorators: compare the declared order and config keys against the
 * live decorator in Graylog (matched by the (stream, type) pair). Best-effort
 * — a decorator or stream that can't be matched is skipped rather than
 * raising false drift. Read-only: GET /api/search/decorators.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = decoratorsFromList(await getJson<unknown>(`${base}/api/search/decorators`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const type = asString(item.fields.type)
    if (!type) continue

    const streamTitle = asString(item.fields.stream_title)
    const streamId = streamTitle ? await resolveDecoratorStreamId(base, headers, streamTitle) : ''
    if (streamTitle && !streamId) continue

    const match = findDecorator(live, streamId, type)
    if (!match) continue

    const label = `${type}${streamTitle ? ` (${streamTitle})` : ' (global)'}`
    const expectedOrder = toInt(item.fields.order, 0)
    const actualOrder = typeof match.order === 'number' ? match.order : 0
    if (expectedOrder !== actualOrder) {
      diffs.push({ field: `${label}.order`, expected: String(expectedOrder), actual: String(actualOrder), severity: 'info' })
    }

    const { value: expectedConfig } = parseJsonObject(item.fields.config)
    const actualConfig = (match.config && typeof match.config === 'object' ? match.config : {}) as Record<string, unknown>
    for (const key of Object.keys(expectedConfig)) {
      const exp = asString(expectedConfig[key])
      const act = asString(actualConfig[key])
      if (exp !== act) {
        diffs.push({ field: `${label}.config.${key}`, expected: exp, actual: act, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
