import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { hasSplunkAddress, buildSplunkUrl, buildAuthHeader, getEntityContent, splunkRequest, postForm } from '../../lib/splunkApi'
import { LICENSE_POOLS_PATH } from './deploy'

interface LicensePoolRollbackData {
  previousState?: Array<Record<string, unknown>>
  createdPools?: string[]
  recreatedPools?: string[]
}

/** Settings restored from the deploy-time snapshot (stack_id is immutable — never sent back). */
const RESTORE_KEYS = ['quota', 'peers', 'description'] as const

/**
 * Rollback license pool configuration:
 *  - restores previous quota/peers/description of pre-existing pools
 *  - deletes pools the deploy created
 *
 * Deleting a pool can fail for a stack's fixed default pool (Splunk does not
 * support removing every pool) — that failure is collected and reported
 * rather than aborting the whole rollback, matching how this app's other
 * rollbacks report a partial/manual-cleanup outcome instead of pretending
 * the whole operation is undone.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, rollbackData } = ctx

  if (!credential || !hasSplunkAddress(component, connectivity, connectivityProvider)) {
    return { success: false, message: 'Missing credential or Splunk management address for rollback' }
  }

  const data = (rollbackData as LicensePoolRollbackData) || {}
  const previousState = data.previousState ?? []
  const createdPools = data.createdPools ?? []
  const recreatedPools = new Set(data.recreatedPools ?? [])

  if (previousState.length === 0 && createdPools.length === 0) {
    return { success: false, message: 'No previous state available for license pool rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider, ctx.settings)
  const auth = buildAuthHeader(credential)
  const undeletable: string[] = []

  try {
    for (const poolState of previousState) {
      const name = poolState.name as string
      const poolPath = `${LICENSE_POOLS_PATH}/${encodeURIComponent(name)}`

      const payload: Record<string, string> = {}
      for (const key of RESTORE_KEYS) {
        const value = poolState[key]
        if (value === undefined || value === null) continue
        payload[key] = String(value)
      }
      if (recreatedPools.has(name)) {
        const current = await getEntityContent(baseUrl, auth, poolPath)
        if (current && String(current.stack_id) !== String(poolState.stack_id)) {
          await splunkRequest(`${baseUrl}${poolPath}`, { method: 'DELETE', headers: auth })
        }
        if (!current || String(current.stack_id) !== String(poolState.stack_id)) {
          await postForm(baseUrl, auth, LICENSE_POOLS_PATH, { name, stack_id: String(poolState.stack_id), ...payload })
          continue
        }
      }
      if (Object.keys(payload).length > 0) {
        await postForm(baseUrl, auth, poolPath, payload)
      }
    }

    for (const name of createdPools) {
      try {
        await splunkRequest(`${baseUrl}${LICENSE_POOLS_PATH}/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          headers: auth,
        })
      } catch {
        undeletable.push(name)
      }
    }

    const actions: string[] = []
    if (previousState.length > 0) actions.push(`restored ${previousState.length} pool(s)`)
    const deletedCount = createdPools.length - undeletable.length
    if (deletedCount > 0) actions.push(`deleted ${deletedCount} created pool(s)`)
    if (undeletable.length > 0) {
      actions.push(
        `could NOT delete ${undeletable.length} pool(s) (${undeletable.join(', ')}) — Splunk does not allow ` +
          'removing every pool (e.g. a stack\'s fixed default pool); remove manually if unwanted',
      )
    }
    return { success: undeletable.length === 0, message: `Rollback ${undeletable.length ? 'incomplete' : 'complete'}: ${actions.join('; ')}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
