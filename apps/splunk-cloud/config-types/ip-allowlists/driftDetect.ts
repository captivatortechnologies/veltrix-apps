import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import {
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractAllowlistSpecs, normalizeSubnet } from './validate'

/**
 * Detect drift between the deployed IP allow lists and the live ACS state.
 * Declared subnets missing from the live list are critical (access broken);
 * live subnets not declared are warnings when the feature is reconciled
 * (removeUndeclared) and informational otherwise.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return { hasDrift: false, diffs: [] }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractAllowlistSpecs(ctx.deployedConfig).filter((s) => s.feature)

  for (const spec of specs) {
    try {
      const res = await acsRequest(
        acs,
        'GET',
        `/access/${encodeURIComponent(spec.feature)}/ipallowlists`,
      )

      if (res.status !== 200) {
        diffs.push({
          field: spec.feature,
          expected: 'readable',
          actual: `ACS returned HTTP ${res.status}`,
          severity: 'critical',
        })
        continue
      }

      const live = (parseJson<{ subnets?: string[] }>(res.body)?.subnets ?? []).map(normalizeSubnet)

      for (const subnet of spec.subnets) {
        if (!live.includes(subnet)) {
          diffs.push({
            field: `${spec.feature}.subnets`,
            expected: subnet,
            actual: 'missing',
            severity: 'critical',
          })
        }
      }

      for (const subnet of live) {
        if (!spec.subnets.includes(subnet)) {
          diffs.push({
            field: `${spec.feature}.subnets`,
            expected: 'not declared',
            actual: subnet,
            severity: spec.removeUndeclared ? 'warning' : 'info',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: spec.feature,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
