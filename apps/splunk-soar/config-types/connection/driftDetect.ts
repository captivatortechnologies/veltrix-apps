import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, soarRequest } from '../../lib/soarApi'

/**
 * Detect drift for a SOAR connection profile.
 *
 * A connection profile holds no configuration on the SOAR side (see
 * deploy.ts), so there is nothing to diff. The only thing that can "drift" is
 * reachability, which is surfaced as a critical diff when the instance can no
 * longer be reached. A reachable instance reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity } = ctx

  if (!credential || !connectivity) {
    // Without credential/connectivity there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }

  const baseUrl = buildSoarUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  try {
    await soarRequest(`${baseUrl}/rest/version`, { method: 'GET', headers: auth })
    return { hasDrift: false, diffs: [] }
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'server_reachable',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }
}
