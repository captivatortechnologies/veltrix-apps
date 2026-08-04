import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import { parseValueLines, settingsFromValues, findSetting, type SonarSetting } from './_shared'

/**
 * Drift for global settings: compare the declared value/values against the live setting in
 * SonarQube, GLOBAL scope only (`component` is never sent). Best-effort — if the batched
 * read fails entirely, no drift is asserted. Read-only:
 *   GET /api/settings/values?keys=k1,k2,...  → live settings (value, values, inherited),
 *   batched into ONE call across every declared key.
 */
interface SettingsValuesResponse {
  settings?: SonarSetting[]
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const keys = [...new Set(items.map((item) => String(item.fields.key ?? '').trim()).filter(Boolean))]
  if (keys.length === 0) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: SonarSetting[]
  try {
    const res = await getJson<SettingsValuesResponse>(`${base}/api/settings/values?keys=${encodeURIComponent(keys.join(','))}`, headers)
    live = settingsFromValues(res)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read settings, no drift asserted
  }

  for (const item of items) {
    const key = String(item.fields.key ?? '').trim()
    if (!key) continue

    const value = String(item.fields.value ?? '').trim()
    const values = parseValueLines(item.fields.values)
    if (!value && values.length === 0) continue

    const match = findSetting(live, key)
    const isUnset = !match || match.inherited === true

    if (isUnset) {
      diffs.push({ field: key, expected: value || values.join(', '), actual: '(default/unset)', severity: 'warning' })
      continue
    }

    if (value) {
      const liveValue = String(match!.value ?? '')
      if (liveValue !== value) {
        diffs.push({ field: key, expected: value, actual: liveValue, severity: 'warning' })
      }
    } else {
      const liveValues = Array.isArray(match!.values) ? match!.values.map((v) => String(v)) : []
      const same = liveValues.length === values.length && liveValues.every((v, i) => v === values[i])
      if (!same) {
        diffs.push({ field: key, expected: values.join(', '), actual: liveValues.join(', '), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
