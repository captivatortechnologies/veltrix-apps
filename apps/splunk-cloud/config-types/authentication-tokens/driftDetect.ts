import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
} from '../../lib/splunkRest'
import { TOKEN_AUTH_SETTINGS_PATH } from './deploy'
import { extractTokenSettingsSpec, isTokenAuthEnabled, readLiveExpiration } from './validate'

/**
 * Detect drift between the deployed token-authentication settings and the live
 * settings on the stack (GET /services/admin/token-auth/tokens_auth on port 8089).
 *
 * Severity policy:
 *  - REST unreachable ..................................... critical
 *  - token authentication enabled/disabled changed ....... critical (auth change)
 *  - default token expiration changed .................... warning
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveRestToken(ctx.credential)
  if (!token) {
    // Without a token there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }

  const spec = extractTokenSettingsSpec(ctx.deployedConfig)
  if (!spec) {
    return { hasDrift: false, diffs: [] }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  try {
    const live = await getEntityContent(baseUrl, auth, TOKEN_AUTH_SETTINGS_PATH, timeoutMs)
    if (!live) {
      return {
        hasDrift: true,
        diffs: [
          {
            field: 'tokens_auth',
            expected: 'readable',
            actual: 'token-authentication settings entity not found',
            severity: 'critical',
          },
        ],
      }
    }

    if (spec.tokenAuthEnabled !== undefined) {
      const liveEnabled = isTokenAuthEnabled(live)
      if (liveEnabled !== spec.tokenAuthEnabled) {
        diffs.push({
          field: 'tokenAuthEnabled',
          expected: spec.tokenAuthEnabled,
          actual: liveEnabled,
          severity: 'critical',
        })
      }
    }

    if (spec.defaultExpiration !== undefined) {
      const liveExpiration = readLiveExpiration(live)
      if (liveExpiration !== spec.defaultExpiration) {
        diffs.push({
          field: 'defaultExpiration',
          expected: spec.defaultExpiration,
          actual: liveExpiration ?? 'not set',
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'tokens_auth',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
