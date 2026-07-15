import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { listServiceTokens } from './deploy'
import { extractServiceTokenSpecs, serviceTokenKey } from './validate'

/**
 * Detect drift between the deployed service token configuration and the live
 * account. Re-finds each declared token by name and reports a missing token as
 * critical drift.
 *
 * ⚠ SECURITY: drift is PRESENCE ONLY. The client_secret is write-only and must
 * never be read back or diffed, and token metadata beyond existence is not
 * compared — so the secret is never touched. Account-scoped: with no account id
 * there is nothing to compare, so no drift is reported.
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

  const specs = extractServiceTokenSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listServiceTokens(client)
    const keys = new Set(live.filter((t) => t.name).map((t) => serviceTokenKey(t.name as string)))

    for (const spec of specs) {
      if (!keys.has(serviceTokenKey(spec.name))) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
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
