import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkRequest, postForm } from '../../lib/splunkApi'

interface IndexRollbackData {
  previousState?: Array<Record<string, unknown>>
  createdIndexes?: string[]
}

/** Writable settings restored from the deploy-time snapshot. */
const RESTORE_KEYS = [
  'maxTotalDataSizeMB',
  'frozenTimePeriodInSecs',
  'maxDataSize',
  'journalCompression',
  'coldToFrozenDir',
  'enableTsidxReduction',
  'timePeriodInSecBeforeTsidxReduction',
] as const

/**
 * Rollback index configuration:
 *  - restores the previous settings of indexes that existed before the deploy
 *  - deletes indexes the deploy created (they had no previous state)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, rollbackData } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for rollback' }
  }

  const data = (rollbackData as IndexRollbackData) || {}
  const previousState = data.previousState ?? []
  const createdIndexes = data.createdIndexes ?? []

  if (previousState.length === 0 && createdIndexes.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  try {
    // Restore modified indexes to their captured settings
    for (const indexState of previousState) {
      const name = indexState.name as string
      const payload: Record<string, string> = {}
      for (const key of RESTORE_KEYS) {
        if (indexState[key] !== undefined && indexState[key] !== null) {
          payload[key] = String(indexState[key])
        }
      }
      if (Object.keys(payload).length === 0) continue
      await postForm(baseUrl, auth, `/services/data/indexes/${encodeURIComponent(name)}`, payload)
    }

    // Remove indexes that were created by the deployment being rolled back
    for (const name of createdIndexes) {
      await splunkRequest(`${baseUrl}/services/data/indexes/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: auth,
      })
    }

    const actions: string[] = []
    if (previousState.length > 0) actions.push(`restored ${previousState.length} index(es)`)
    if (createdIndexes.length > 0) actions.push(`deleted ${createdIndexes.length} created index(es)`)
    return { success: true, message: `Rollback complete: ${actions.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
