import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, parseJsonObject } from '../../lib/coerce'
import { outputsFromList, findOutput } from './_shared'

/**
 * Drift for outputs: compare the type and each DECLARED configuration key
 * against the live output in Graylog. Only declared keys are compared —
 * Graylog's update MERGES configuration rather than replacing it (see
 * _shared.ts), so a key present live but never declared is not drift.
 * Best-effort, read-only: GET /api/system/outputs.
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
    live = outputsFromList(await getJson<unknown>(`${base}/api/system/outputs`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const title = asString(item.fields.title)
    const match = findOutput(live, title)
    if (!match) continue

    const expectedType = asString(item.fields.type)
    const actualType = asString(match.type)
    if (expectedType !== actualType) {
      diffs.push({ field: `${title}.type`, expected: expectedType, actual: actualType, severity: 'warning' })
    }

    const { value: expectedConfig } = parseJsonObject(item.fields.configuration)
    const actualConfig = (match.configuration && typeof match.configuration === 'object' ? match.configuration : {}) as Record<string, unknown>
    for (const key of Object.keys(expectedConfig)) {
      const exp = asString(expectedConfig[key])
      const act = asString(actualConfig[key])
      if (exp !== act) {
        diffs.push({ field: `${title}.configuration.${key}`, expected: exp, actual: act, severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
