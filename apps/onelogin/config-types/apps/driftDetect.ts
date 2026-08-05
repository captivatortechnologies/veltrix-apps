import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, stableStringify } from '../../lib/oneLogin'
import { listApps } from './deploy'
import { extractAppSpecs, parseJsonObject } from './validate'

/**
 * Detect drift between the deployed app configuration and the live account.
 * Re-finds each declared app by NAME and diffs the managed writable fields:
 * description, notes, visible, allowAssumedSignin, policyId, tabId,
 * provisioningEnabled, and (when declared) configuration/parameters.
 *
 * Server-managed read-only fields (id, connector_id, auth_method, sso,
 * icon_url, role_ids, created_at, updated_at) are never compared - only the
 * fields this config type manages. configuration/parameters are compared
 * only when the canvas DECLARES them (blank means "not managed here" - see
 * canvas.yaml), so an app's out-of-band configuration is never flagged.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAppSpecs(ctx.deployedConfig).filter((s) => s.name)

  let apps
  try {
    apps = await listApps(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'onelogin-account',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const live = apps.find((a) => a.name === spec.name) ?? null

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDescription = typeof live.description === 'string' ? live.description : ''
    if ((spec.description ?? '') !== liveDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description ?? 'not set',
        actual: liveDescription || 'not set',
        severity: 'warning',
      })
    }

    const liveNotes = typeof live.notes === 'string' ? live.notes : ''
    if ((spec.notes ?? '') !== liveNotes) {
      diffs.push({
        field: `${spec.name}.notes`,
        expected: spec.notes ?? 'not set',
        actual: liveNotes || 'not set',
        severity: 'info',
      })
    }

    const liveVisible = live.visible ?? true
    if (spec.visible !== liveVisible) {
      diffs.push({ field: `${spec.name}.visible`, expected: spec.visible, actual: liveVisible, severity: 'warning' })
    }

    const liveAssumed = live.allow_assumed_signin ?? false
    if (spec.allowAssumedSignin !== liveAssumed) {
      diffs.push({
        field: `${spec.name}.allowAssumedSignin`,
        expected: spec.allowAssumedSignin,
        actual: liveAssumed,
        severity: 'critical',
      })
    }

    const livePolicyId = live.policy_id ?? null
    if ((spec.policyId ?? null) !== livePolicyId) {
      diffs.push({
        field: `${spec.name}.policyId`,
        expected: spec.policyId ?? 'not set',
        actual: livePolicyId ?? 'not set',
        severity: 'warning',
      })
    }

    const liveTabId = live.tab_id ?? null
    if ((spec.tabId ?? null) !== liveTabId) {
      diffs.push({ field: `${spec.name}.tabId`, expected: spec.tabId ?? 'not set', actual: liveTabId ?? 'not set', severity: 'info' })
    }

    const liveProvisioning = live.provisioning?.enabled ?? false
    if (spec.provisioningEnabled !== liveProvisioning) {
      diffs.push({
        field: `${spec.name}.provisioningEnabled`,
        expected: spec.provisioningEnabled,
        actual: liveProvisioning,
        severity: 'warning',
      })
    }

    if (spec.configurationJson) {
      const specConfig = parseJsonObject(spec.configurationJson) ?? {}
      const liveConfig = live.configuration ?? {}
      if (stableStringify(specConfig) !== stableStringify(liveConfig)) {
        diffs.push({
          field: `${spec.name}.configuration`,
          expected: stableStringify(specConfig),
          actual: stableStringify(liveConfig),
          severity: 'critical',
        })
      }
    }

    if (spec.parametersJson) {
      const specParams = parseJsonObject(spec.parametersJson) ?? {}
      const liveParams = live.parameters ?? {}
      if (stableStringify(specParams) !== stableStringify(liveParams)) {
        diffs.push({
          field: `${spec.name}.parameters`,
          expected: stableStringify(specParams),
          actual: stableStringify(liveParams),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
