import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, rollbackData } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for rollback' }
  }

  const previousState = (rollbackData as { previousState?: Array<Record<string, unknown>> })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for role rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  try {
    for (const roleState of previousState) {
      const name = roleState.name as string
      const payload: Record<string, string> = {}
      if (roleState.srchFilter) payload.srchFilter = String(roleState.srchFilter)
      if (roleState.srchDiskQuota) payload.srchDiskQuota = String(roleState.srchDiskQuota)
      if (roleState.srchJobsQuota) payload.srchJobsQuota = String(roleState.srchJobsQuota)

      const res = await fetch(`${baseUrl}/services/authorization/roles/${name}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString(),
      })
      if (!res.ok) throw new Error(`Failed to rollback role "${name}": ${res.status}`)
    }

    return { success: true, message: `Rolled back ${previousState.length} role(s) to previous state` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

function buildSplunkUrl(component: RollbackContext['component'], connectivity: NonNullable<RollbackContext['connectivity']>): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<RollbackContext['credential']>): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  return { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}` }
}
