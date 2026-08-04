import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { parseValueLines, settingsFromValues, findSetting, type SonarSetting } from './_shared'

/**
 * Deploy SonarQube global settings over the Web API (/api/settings), GLOBAL scope only —
 * `component` is never sent:
 *   read (context): GET  /api/settings/values?keys=k1,k2,...  → prior state for every
 *                   declared key, batched into ONE call
 *   write:          POST /api/settings/set                    { key, value? | values? }
 *
 * The setting KEY is the identity used to upsert. rollbackData records, per key, whether it
 * was explicitly set at this level before this deploy (`wasSet`) and its prior value(s): a
 * key the server reports `inherited: true` — or doesn't return at all, e.g. a brand-new
 * custom property the server has no default for — was NOT explicitly set, so rollback
 * reverts it with `reset` instead of trying to restore an explicit prior value that never
 * existed.
 */
interface SettingsValuesResponse {
  settings?: SonarSetting[]
  setSecuredSettings?: string[]
}

interface RollbackSettingEntry {
  key: string
  wasSet: boolean
  priorValue?: string
  priorValues?: string[]
}

async function priorSettings(base: string, headers: Record<string, string>, keys: string[]): Promise<SonarSetting[]> {
  if (keys.length === 0) return []
  try {
    const res = await getJson<SettingsValuesResponse>(`${base}/api/settings/values?keys=${encodeURIComponent(keys.join(','))}`, headers)
    return settingsFromValues(res)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for global settings deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const declaredKeys = [...new Set(items.map((item) => String(item.fields.key ?? '').trim()).filter(Boolean))]
  const prior = await priorSettings(base, headers, declaredKeys)

  const settings: RollbackSettingEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const key = String(item.fields.key ?? '').trim()
      if (!key) continue

      const value = String(item.fields.value ?? '').trim()
      const values = parseValueLines(item.fields.values)

      const existing = findSetting(prior, key)
      const wasSet = existing != null && existing.inherited !== true

      await postForm(`${base}/api/settings/set`, headers, {
        key,
        value: value || undefined,
        values: values.length > 0 ? values : undefined,
      })

      settings.push({ key, wasSet, priorValue: existing?.value, priorValues: existing?.values })
      applied.push(key)
    }

    return {
      success: true,
      message: `Applied ${applied.length} setting(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { settings },
    }
  } catch (error) {
    return {
      success: false,
      message: `Global settings deploy failed after ${applied.length} setting(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { settings },
    }
  }
}
