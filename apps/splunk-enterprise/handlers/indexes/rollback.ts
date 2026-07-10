import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

/**
 * Rollback index configuration by restoring the previous state captured during deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, rollbackData } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for rollback' }
  }

  const previousState = (rollbackData as { previousState?: Array<Record<string, unknown>> })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  try {
    for (const indexState of previousState) {
      const name = indexState.name as string
      const payload: Record<string, string> = {}

      if (indexState.maxDataSize) payload.maxDataSize = String(indexState.maxDataSize)
      if (indexState.frozenTimePeriodInSecs) payload.frozenTimePeriodInSecs = String(indexState.frozenTimePeriodInSecs)

      const res = await fetch(
        `${baseUrl}/services/data/indexes/${name}`,
        {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(payload).toString(),
        },
      )

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Failed to rollback index "${name}": ${res.status} ${text}`)
      }
    }

    return {
      success: true,
      message: `Rolled back ${previousState.length} index(es) to previous state`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

function buildSplunkUrl(
  component: RollbackContext['component'],
  connectivity: NonNullable<RollbackContext['connectivity']>,
): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<RollbackContext['credential']>): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}
