import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for Splunk role deployment' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)
  const rollbackSnapshot: Record<string, unknown>[] = []
  const deployedRoles: string[] = []

  try {
    for (const section of canvas.sections) {
      const roleName = section.fields.name as string
      const fields = section.fields

      // Capture current state
      const existing = await getExistingRole(baseUrl, auth, roleName)
      if (existing) {
        rollbackSnapshot.push({ name: roleName, ...existing })
      }

      const payload: Record<string, string> = { name: roleName }
      if (fields.capabilities && Array.isArray(fields.capabilities)) {
        for (const cap of fields.capabilities as string[]) {
          payload[`capabilities`] = cap // Splunk accepts multiple capability params
        }
      }
      if (fields.importedRoles && Array.isArray(fields.importedRoles)) {
        for (const role of fields.importedRoles as string[]) {
          payload[`imported_roles`] = role
        }
      }
      if (fields.srchFilter) payload.srchFilter = fields.srchFilter as string
      if (fields.srchDiskQuota) payload.srchDiskQuota = String(fields.srchDiskQuota)
      if (fields.srchJobsQuota) payload.srchJobsQuota = String(fields.srchJobsQuota)

      if (existing) {
        await splunkRequest(`${baseUrl}/services/authorization/roles/${roleName}`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(payload).toString(),
        })
      } else {
        await splunkRequest(`${baseUrl}/services/authorization/roles`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(payload).toString(),
        })
      }

      deployedRoles.push(roleName)
    }

    return {
      success: true,
      message: `Deployed ${deployedRoles.length} role(s): ${deployedRoles.join(', ')}`,
      artifacts: { deployedRoles },
      rollbackData: { previousState: rollbackSnapshot },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployedRoles.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

function buildSplunkUrl(component: DeployContext['component'], connectivity: NonNullable<DeployContext['connectivity']>): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<DeployContext['credential']>): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  return { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}` }
}

async function getExistingRole(baseUrl: string, auth: Record<string, string>, roleName: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await splunkRequest(`${baseUrl}/services/authorization/roles/${roleName}?output_mode=json`, { method: 'GET', headers: auth })
    const data = JSON.parse(res)
    return data?.entry?.[0]?.content || null
  } catch { return null }
}

async function splunkRequest(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, { method: options.method, headers: options.headers, body: options.body, signal: controller.signal })
    if (!res.ok) { const text = await res.text(); throw new Error(`Splunk API ${res.status}: ${text}`) }
    return await res.text()
  } finally { clearTimeout(timeout) }
}
