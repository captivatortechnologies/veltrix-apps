import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { PATCH_ENTITY_SETTINGS_MUTATION, buildRestorePatch, type OpenctiEntitySetting } from './_shared'

/**
 * Undo an entity-settings deploy from rollbackData.previous (written by
 * deploy()): every entry restores its prior fields via
 * entitySettingsFieldPatch(ids: [id], input) — there is no delete branch (this
 * type never creates anything; the setting singleton always pre-existed).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ targetType: string; settingId: string; setting: OpenctiEntitySetting }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for entity-setting rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { settingId, setting } of previous) {
      await graphql(base, headers, PATCH_ENTITY_SETTINGS_MUTATION, { ids: [settingId], input: buildRestorePatch(setting) })
      restored++
    }
    return { success: true, message: `Rolled back ${restored} entity setting(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
