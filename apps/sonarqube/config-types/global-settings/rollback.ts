import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, postForm } from '../../lib/sonarqubeApi'

/**
 * Undo a global-settings deploy from rollbackData (written by deploy()):
 *   - a key that was explicitly SET at this level before the deploy (`wasSet: true`) has
 *     its prior value(s) restored (POST /api/settings/set).
 *   - a key that was at its default before the deploy (`wasSet: false` — inherited, or not
 *     recognised by the server at all) is reverted to default (POST /api/settings/reset,
 *     `keys` sent as a single-key comma-list).
 * Best-effort — a failure on one key does not abort the rest. GLOBAL scope only —
 * `component` is never sent.
 */
interface RollbackSettingEntry {
  key: string
  wasSet: boolean
  priorValue?: string
  priorValues?: string[]
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { settings?: RollbackSettingEntry[] }
  const settings = data.settings ?? []
  if (settings.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for global settings rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let reset = 0
  const failures: string[] = []

  for (const setting of settings) {
    try {
      if (setting.wasSet) {
        await postForm(`${base}/api/settings/set`, headers, {
          key: setting.key,
          value: setting.priorValue || undefined,
          values: setting.priorValues && setting.priorValues.length > 0 ? setting.priorValues : undefined,
        })
        restored++
      } else {
        await postForm(`${base}/api/settings/reset`, headers, { keys: setting.key })
        reset++
      }
    } catch (error) {
      failures.push(`${setting.key}: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${restored} restored, ${reset} reset to default. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back global settings: ${restored} restored, ${reset} reset to default.` }
}
