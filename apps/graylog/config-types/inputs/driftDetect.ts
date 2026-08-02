import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, toBool, parseJsonObject } from '../../lib/coerce'
import { inputsFromList, findInput } from './_shared'

/**
 * Drift for inputs: compare the type, global flag and each DECLARED configuration
 * key against the live input in Graylog. Only declared keys are compared (the live
 * input's `attributes` include server-defaulted keys we did not set, which would
 * otherwise raise false drift). Best-effort, read-only: GET /api/system/inputs.
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
    live = inputsFromList(await getJson<unknown>(`${base}/api/system/inputs`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const title = asString(item.fields.title)
    const match = findInput(live, title)
    if (!match) continue

    const expectedType = asString(item.fields.type)
    const actualType = asString(match.type)
    if (expectedType !== actualType) {
      diffs.push({ field: `${title}.type`, expected: expectedType, actual: actualType, severity: 'warning' })
    }

    const expectedGlobal = toBool(item.fields.global)
    const actualGlobal = toBool(match.global)
    if (expectedGlobal !== actualGlobal) {
      diffs.push({ field: `${title}.global`, expected: expectedGlobal, actual: actualGlobal, severity: 'warning' })
    }

    const { value: expectedConfig } = parseJsonObject(item.fields.configuration)
    const actualConfig = (match.attributes && typeof match.attributes === 'object' ? match.attributes : {}) as Record<string, unknown>
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
