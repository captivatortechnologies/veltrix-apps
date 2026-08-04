import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LOOKUP_ENTITY_SETTING_QUERY, normalizeBool, type OpenctiEntitySetting } from './_shared'

/**
 * Drift for entity settings: compare the three declared booleans against the
 * live setting in OpenCTI (looked up by `target_type`). The two JSON-blob
 * fields (`attributes_configuration`, `overview_layout_customization`) are
 * declared but intentionally not diffed — free-form JSON OpenCTI may
 * reformat, the same precedent used by every other JSON-blob field in this
 * app. Best-effort — a `target_type` that can't be resolved (missing /
 * transient error) is skipped rather than raising false drift. Read-only:
 * entitySettingByType.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const targetType = String(item.fields.target_type ?? '').trim()
    if (!targetType) continue

    let match: OpenctiEntitySetting | null
    try {
      const data = await graphql<{ entitySettingByType?: OpenctiEntitySetting | null }>(base, headers, LOOKUP_ENTITY_SETTING_QUERY, { targetType })
      match = data?.entitySettingByType ?? null
    } catch {
      continue // best-effort: can't read this one, no drift asserted for it
    }
    if (!match) continue

    const boolChecks: Array<[string, boolean, boolean | null | undefined]> = [
      ['platform_hidden_type', normalizeBool(item.fields.platform_hidden_type, false), match.platform_hidden_type],
      ['enforce_reference', normalizeBool(item.fields.enforce_reference, false), match.enforce_reference],
      ['platform_entity_files_ref', normalizeBool(item.fields.platform_entity_files_ref, false), match.platform_entity_files_ref],
    ]
    for (const [field, expected, actual] of boolChecks) {
      if (actual != null && expected !== actual) {
        diffs.push({ field: `${targetType}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
