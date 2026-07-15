import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { listAccessApps } from './deploy'
import { accessAppKey, extractAccessAppSpecs, type LiveAccessApp } from './validate'

/**
 * Detect drift between the deployed Access application configuration and the live
 * account. Re-finds each declared application by name and diffs the managed
 * fields (domain, session_duration); a missing application is critical drift.
 * Returns no drift when no account is available (account-scoped objects need one).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  if (!(await client.hasAccount())) {
    return { hasDrift: false, diffs: [] }
  }

  const specs = extractAccessAppSpecs(ctx.deployedConfig).filter((s) => s.name && s.domain)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAccessApps(client)
    const byKey = new Map<string, LiveAccessApp>(
      live.filter((a) => a.name).map((a) => [accessAppKey(a.name as string), a]),
    )

    for (const spec of specs) {
      const label = spec.name
      const found = byKey.get(accessAppKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.domain ?? '') !== spec.domain) {
        diffs.push({ field: `${label}.domain`, expected: spec.domain, actual: found.domain ?? 'not set', severity: 'warning' })
      }
      if ((found.session_duration ?? '') !== spec.sessionDuration) {
        diffs.push({
          field: `${label}.session_duration`,
          expected: spec.sessionDuration,
          actual: found.session_duration ?? 'not set',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
