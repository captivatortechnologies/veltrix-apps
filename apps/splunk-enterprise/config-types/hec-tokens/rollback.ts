import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkRequest, postForm } from '../../lib/splunkApi'
import { HEC_BASE_PATH } from './deploy'

interface HecRollbackData {
  previousState?: Array<Record<string, unknown>>
  createdTokens?: string[]
}

/** Settings restored from the deploy-time snapshot. */
const RESTORE_KEYS = ['index', 'indexes', 'sourcetype', 'source', 'description', 'useACK'] as const

/**
 * Rollback HEC token configuration:
 *  - restores previous settings (including enabled state) of pre-existing tokens
 *  - deletes tokens the deploy created
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, rollbackData } = ctx

  if (!credential || (!connectivity && !connectivityProvider)) {
    return { success: false, message: 'Missing credential or connectivity for rollback' }
  }

  const data = (rollbackData as HecRollbackData) || {}
  const previousState = data.previousState ?? []
  const createdTokens = data.createdTokens ?? []

  if (previousState.length === 0 && createdTokens.length === 0) {
    return { success: false, message: 'No previous state available for HEC token rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  try {
    for (const tokenState of previousState) {
      const name = tokenState.name as string
      const tokenPath = `${HEC_BASE_PATH}/${encodeURIComponent(name)}`

      const payload: Record<string, string> = {}
      for (const key of RESTORE_KEYS) {
        const value = tokenState[key]
        if (value === undefined || value === null) continue
        payload[key] = Array.isArray(value) ? value.map(String).join(',') : String(value)
      }
      if (Object.keys(payload).length > 0) {
        await postForm(baseUrl, auth, tokenPath, payload)
      }

      // Restore enabled/disabled state
      if (tokenState.disabled !== undefined) {
        const wasDisabled = tokenState.disabled === true || tokenState.disabled === '1' || tokenState.disabled === 1
        await splunkRequest(`${baseUrl}${tokenPath}/${wasDisabled ? 'disable' : 'enable'}`, {
          method: 'POST',
          headers: auth,
        })
      }
    }

    for (const name of createdTokens) {
      await splunkRequest(`${baseUrl}${HEC_BASE_PATH}/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: auth,
      })
    }

    const actions: string[] = []
    if (previousState.length > 0) actions.push(`restored ${previousState.length} token(s)`)
    if (createdTokens.length > 0) actions.push(`deleted ${createdTokens.length} created token(s)`)
    return { success: true, message: `Rollback complete: ${actions.join(', ')}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
