import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, parseJsonObject } from '../../lib/coerce'
import { lookupCachesFromList, findLookupCache } from './_shared'

/**
 * Drift for lookup caches: compare the title and the declared `config` keys
 * against the live cache in Graylog. Only declared config keys are compared
 * (server-defaulted keys we did not set would otherwise raise false drift).
 * Best-effort, read-only: GET /api/system/lookup/caches.
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
    live = lookupCachesFromList(await getJson<unknown>(`${base}/api/system/lookup/caches`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = asString(item.fields.name)
    const match = findLookupCache(live, name)
    if (!match) continue

    const expectedTitle = asString(item.fields.title)
    const actualTitle = asString(match.title)
    if (expectedTitle !== actualTitle) {
      diffs.push({ field: `${name}.title`, expected: expectedTitle, actual: actualTitle, severity: 'info' })
    }

    const { value: expectedConfig } = parseJsonObject(item.fields.config)
    const actualConfig = (match.config && typeof match.config === 'object' ? match.config : {}) as Record<string, unknown>
    for (const key of Object.keys(expectedConfig)) {
      const exp = asString(expectedConfig[key])
      const act = asString(actualConfig[key])
      if (exp !== act) {
        diffs.push({ field: `${name}.config.${key}`, expected: exp, actual: act, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
