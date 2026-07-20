import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { getAdminNotifications, getPerClient, getWarningThreshold } from './deploy'
import { extractRateLimitSpecs, INHERIT } from './validate'

/**
 * Detect drift between the deployed rate-limit settings and the live org.
 * Compares:
 *   - admin notifications enabled/disabled
 *   - per-client default mode + each declared use-case override
 *   - warning threshold (only when the canvas declares one)
 *
 * Server-managed fields (_links) are never modeled so they cannot read as drift.
 * An INHERIT override is compared as "absent" on the live side.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRateLimitSpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }
  const spec = specs[0]

  try {
    // admin notifications
    const admin = await getAdminNotifications(client)
    const liveAdmin = admin?.notificationsEnabled === true
    if (liveAdmin !== spec.adminNotificationsEnabled) {
      diffs.push({
        field: 'adminNotificationsEnabled',
        expected: spec.adminNotificationsEnabled,
        actual: liveAdmin,
        severity: 'warning',
      })
    }

    // per-client default mode
    const perClient = await getPerClient(client)
    const liveDefault = (perClient?.defaultMode ?? '').toString().toUpperCase()
    if (liveDefault !== spec.perClientDefaultMode) {
      diffs.push({
        field: 'perClientDefaultMode',
        expected: spec.perClientDefaultMode,
        actual: liveDefault || 'not set',
        severity: 'critical',
      })
    }

    // per-client use-case overrides — an INHERIT expected value means "absent"
    const liveOverrides = perClient?.useCaseModeOverrides ?? {}
    const overridePairs: Array<[string, string, string]> = [
      ['perClientLoginPageMode', 'LOGIN_PAGE', spec.perClientLoginPageMode],
      ['perClientOAuth2AuthorizeMode', 'OAUTH2_AUTHORIZE', spec.perClientOAuth2AuthorizeMode],
      ['perClientOIEAppIntentMode', 'OIE_APP_INTENT', spec.perClientOIEAppIntentMode],
    ]
    for (const [field, apiKey, expected] of overridePairs) {
      const liveRaw = liveOverrides[apiKey]
      const liveValue = typeof liveRaw === 'string' && liveRaw.trim() ? liveRaw.trim().toUpperCase() : INHERIT
      if (liveValue !== expected) {
        diffs.push({
          field,
          expected: expected === INHERIT ? 'inherit (no override)' : expected,
          actual: liveValue === INHERIT ? 'inherit (no override)' : liveValue,
          severity: 'warning',
        })
      }
    }

    // warning threshold — only when the canvas declares one
    if (spec.warningThresholdPercent !== undefined) {
      const threshold = await getWarningThreshold(client)
      const liveThreshold = typeof threshold?.warningThreshold === 'number' ? threshold.warningThreshold : undefined
      if (liveThreshold !== spec.warningThresholdPercent) {
        diffs.push({
          field: 'warningThresholdPercent',
          expected: spec.warningThresholdPercent,
          actual: liveThreshold ?? 'not set',
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'rate-limit-settings',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
