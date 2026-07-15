import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { listLists } from './deploy'
import { extractListSpecs, type LiveList } from './validate'

/**
 * Detect drift between the deployed List configuration and the live account.
 * Re-finds each declared list by name and diffs its description and item count
 * (Cloudflare reports num_items on the list object); a missing list is critical
 * drift. Returns no drift when the account is unavailable — there is nothing to
 * compare against, matching the deploy/health guard for account-scoped objects.
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

  const specs = extractListSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listLists(client)
    const byName = new Map<string, LiveList>(live.filter((l) => l.name).map((l) => [l.name as string, l]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description || '(empty)',
          actual: found.description || '(empty)',
          severity: 'info',
        })
      }
      const expectedCount = spec.items.length
      const actualCount = found.num_items ?? 0
      if (expectedCount !== actualCount) {
        diffs.push({
          field: `${spec.name}.items`,
          expected: String(expectedCount),
          actual: String(actualCount),
          severity: 'warning',
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
