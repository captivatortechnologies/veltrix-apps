import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getEntity } from './deploy'
import { extractEntitySpecs, normalizeList, normalizeMetadata, resolveMetadata } from './validate'

/**
 * Detect drift between the deployed identity entity configuration and the live
 * cluster. Re-reads each entity from GET /identity/entity/name/{name} and diffs
 * ONLY the AUTHORED fields:
 *
 *   - policies → warning (compared as a SET — order-independent)
 *   - disabled → warning
 *   - metadata → info  (converges on the next deploy)
 *
 * The server-computed fields id, aliases, direct_group_ids / inherited_group_ids
 * / group_ids, creation_time and last_update_time are NEVER diffed — they are
 * assigned and maintained by Vault, not authored here.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractEntitySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await getEntity(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      // policies — compared as a set (Vault may return them in any order).
      const expectedPolicies = [...spec.policies].sort()
      const livePolicies = normalizeList(live.policies).sort()
      if (!arraysEqual(expectedPolicies, livePolicies)) {
        diffs.push({
          field: `${spec.name}.policies`,
          expected: expectedPolicies.length ? expectedPolicies.join(', ') : 'none',
          actual: livePolicies.length ? livePolicies.join(', ') : 'none',
          severity: 'warning',
        })
      }

      // disabled — a managed boolean.
      const liveDisabled = live.disabled === true
      if (spec.disabled !== liveDisabled) {
        diffs.push({
          field: `${spec.name}.disabled`,
          expected: String(spec.disabled),
          actual: String(liveDisabled),
          severity: 'warning',
        })
      }

      // metadata — a managed map[string]string that converges on the next deploy.
      const expectedMeta = resolveMetadata(spec.metadataJson)
      const liveMeta = normalizeMetadata(live.metadata)
      if (!metadataEqual(expectedMeta, liveMeta)) {
        diffs.push({
          field: `${spec.name}.metadata`,
          expected: formatMetadata(expectedMeta),
          actual: formatMetadata(liveMeta),
          severity: 'info',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Two string arrays are equal element-for-element (callers pre-sort for sets). */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

/** Two metadata maps are equal when they have the same keys and string values. */
function metadataEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => a[key] === b[key])
}

/** Render a metadata map deterministically (sorted keys) for a drift diff. */
function formatMetadata(meta: Record<string, string>): string {
  const keys = Object.keys(meta).sort()
  if (keys.length === 0) return 'none'
  return keys.map((key) => `${key}=${meta[key]}`).join(', ')
}
