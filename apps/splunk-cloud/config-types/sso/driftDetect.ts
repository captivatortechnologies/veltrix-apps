import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
} from '../../lib/splunkRest'
import { SAML_BASE_PATH } from './deploy'
import { extractSsoSpec, type LiveSamlProvider } from './validate'

/**
 * Detect drift between the deployed SAML SSO provider and the live provider on
 * the stack (GET /services/authentication/providers/SAML/<name> on port 8089).
 *
 * Only NON-secret fields are compared — the IdP certificate is write-only and
 * never read back, so it can never be drift-checked. Severity policy:
 *  - REST unreachable / provider missing ............ critical
 *  - entity ID, SSO URL or attribute mapping changed  warning
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveRestToken(ctx.credential)
  if (!token) {
    // Without a token there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }

  const spec = extractSsoSpec(ctx.deployedConfig)
  if (!spec.providerName) {
    return { hasDrift: false, diffs: [] }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  try {
    const live = (await getEntityContent(
      baseUrl,
      auth,
      `${SAML_BASE_PATH}/${encodeURIComponent(spec.providerName)}`,
      timeoutMs,
    )) as LiveSamlProvider | null

    if (!live) {
      return {
        hasDrift: true,
        diffs: [
          {
            field: spec.providerName,
            expected: 'configured',
            actual: 'no SAML provider present',
            severity: 'critical',
          },
        ],
      }
    }

    const compare = (field: string, expected: string, actual: string) => {
      if (expected !== actual) {
        diffs.push({ field, expected, actual: actual || 'missing', severity: 'warning' })
      }
    }

    compare('entityId', spec.entityId, str(live.entityId))
    compare('idpSSOUrl', spec.ssoUrl, str(live.idpSSOUrl))
    compare('idpSLOUrl', spec.sloUrl, str(live.idpSLOUrl))
    compare('roleAttribute', spec.roleAttribute, str(live.roleAttribute))
    compare('realNameAttribute', spec.realNameAttribute, str(live.realNameAttribute))
    compare('mailAttribute', spec.mailAttribute, str(live.mailAttribute))

    // signAuthnRequest is compared only when the deployed config declared it.
    if (spec.signAuthnRequest !== undefined) {
      const liveSign = toBool(live.signAuthnRequest)
      if (liveSign !== spec.signAuthnRequest) {
        diffs.push({
          field: 'signAuthnRequest',
          expected: spec.signAuthnRequest,
          actual: liveSign,
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: spec.providerName,
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Normalize a live boolean-ish REST value ("1"/"0"/"true"/"false") to a boolean. */
function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}
