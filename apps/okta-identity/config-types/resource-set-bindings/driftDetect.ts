import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { bindingMemberRef, getBinding, listBindingMembers } from './deploy'
import { extractBindingSpecs } from './validate'

/**
 * Detect drift between the deployed resource-set-binding configuration and the live
 * Okta org. Each declared (resourceSet, role) binding is re-fetched and compared:
 *   - existence — a missing binding is CRITICAL (the grant was removed)
 *   - member set (order-insensitive) — read from the members sub-resource and
 *     compared on each member's canonical ORN / principal-URL form
 *
 * The (resourceSet, role) pair is the identity (used to match) so it can never read
 * as drift. Server-managed readOnly fields (membership ids, _links, timestamps) are
 * never modeled.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractBindingSpecs(ctx.deployedConfig).filter(
    (s) => s.resourceSet && s.role && s.members.length > 0,
  )

  for (const spec of specs) {
    const label = `${spec.resourceSet}:${spec.role}`
    try {
      const live = await getBinding(client, spec.resourceSet, spec.role)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // member set — order-insensitive, compared on canonical ORN / principal URL.
      const members = await listBindingMembers(client, spec.resourceSet, spec.role)
      const liveRefs = members.map(bindingMemberRef).filter((r): r is string => !!r)
      const missing = spec.members.filter(
        (ref) => !members.some((m) => m.orn === ref || m._links?.self?.href === ref),
      )
      const extra = members
        .filter((m) => {
          const orn = m.orn
          const href = m._links?.self?.href
          return !spec.members.some((ref) => ref === orn || ref === href)
        })
        .map(bindingMemberRef)
        .filter((r): r is string => !!r)

      if (missing.length > 0 || extra.length > 0) {
        diffs.push({
          field: `${label}.members`,
          expected: [...spec.members].sort(),
          actual: [...liveRefs].sort(),
          severity: 'critical',
        })
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
