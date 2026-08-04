import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LOOKUP_ENTITY_SETTING_QUERY, PATCH_ENTITY_SETTINGS_MUTATION, buildEntitySettingPatch, type OpenctiEntitySetting } from './_shared'

/**
 * Deploy OpenCTI entity settings over the GraphQL API. UNIQUE shape versus
 * every other type: there is no create — `entitySettingByType(targetType)`
 * looks up the (always pre-existing) singleton, and
 * `entitySettingsFieldPatch(ids: [id], input)` patches it. A `target_type`
 * that doesn't resolve is a clear failure for this deploy (not a silent skip
 * and not a create), surfaced via the same "fails after N items" pattern every
 * other type in this app uses.
 *
 * rollbackData records, per item, the prior COMPLETE setting AND its id — so
 * rollback can restore the prior fields exactly (there is never a "delete the
 * one we created" branch here — nothing is ever created).
 */
async function lookupEntitySetting(base: string, headers: Record<string, string>, targetType: string): Promise<OpenctiEntitySetting | null> {
  const data = await graphql<{ entitySettingByType?: OpenctiEntitySetting | null }>(base, headers, LOOKUP_ENTITY_SETTING_QUERY, { targetType })
  return data?.entitySettingByType ?? null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for entity-setting deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ targetType: string; settingId: string; setting: OpenctiEntitySetting }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const targetType = String(item.fields.target_type ?? '').trim()
      if (!targetType) continue

      const existing = await lookupEntitySetting(base, headers, targetType)
      if (!existing?.id) {
        throw new Error(
          `No EntitySetting found for target_type "${targetType}" — it must already exist on the OpenCTI instance ` +
            '(this type never creates one, only patches an existing singleton).',
        )
      }

      await graphql(base, headers, PATCH_ENTITY_SETTINGS_MUTATION, { ids: [existing.id], input: buildEntitySettingPatch(item.fields) })
      previous.push({ targetType, settingId: String(existing.id), setting: existing })
      applied.push(targetType)
    }

    return {
      success: true,
      message: `Applied ${applied.length} entity setting(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Entity-setting deploy failed after ${applied.length} setting(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
