import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, soarRequest } from '../../lib/soarApi'

/**
 * "Deploy" a SOAR connection profile.
 *
 * IMPORTANT: A connection profile is NOT pushed to Splunk SOAR. It only
 * describes how the Veltrix platform REACHES a SOAR instance (endpoint,
 * credential, connectivity). There is therefore no external state to create
 * on the SOAR side. Deploy simply verifies the instance is reachable and
 * authenticating (GET /rest/version) and records that the connection was
 * verified. Rollback has nothing to undo, so rollbackData is empty.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for SOAR connection' }
  }

  const baseUrl = buildSoarUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  try {
    await soarRequest(`${baseUrl}/rest/version`, { method: 'GET', headers: auth })
  } catch (error) {
    return {
      success: false,
      message: `SOAR connection verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }

  return { success: true, message: 'Connection verified', rollbackData: {} }
}
