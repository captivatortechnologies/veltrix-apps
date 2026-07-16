import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listSiteCredentials, resolveSiteId } from './deploy'
import { extractSiteCredentialSpecs, type LiveSiteCredential } from './validate'

/**
 * Detect drift between the deployed site credentials and the live console.
 * Re-finds each declared credential by (site, credential name) and diffs ONLY
 * the description; a missing credential is critical drift.
 *
 * ⚠ The account (and its write-only password) is NEVER diffed — the API masks
 * the secret on read, so any comparison would be meaningless and could leak it.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSiteCredentialSpecs(ctx.deployedConfig).filter((s) => s.siteName && s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const siteIds = new Map<string, number>()
  const bySite = new Map<number, Map<string, LiveSiteCredential>>()

  for (const spec of specs) {
    const label = `${spec.name} @ ${spec.siteName}`
    try {
      const siteId = await resolveSiteId(client, spec.siteName, siteIds)
      let byName = bySite.get(siteId)
      if (!byName) {
        const live = await listSiteCredentials(client, siteId)
        byName = new Map(live.filter((c) => c.name).map((c) => [(c.name as string).toLowerCase(), c]))
        bySite.set(siteId, byName)
      }
      const found = byName.get(spec.name.toLowerCase())
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description || 'not set',
          actual: found.description || 'not set',
          severity: 'info',
        })
      }
    } catch (error) {
      diffs.push({ field: label, expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
