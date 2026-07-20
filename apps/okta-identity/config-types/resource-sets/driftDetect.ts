import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import {
  findResourceSetByLabel,
  listResourceMemberships,
  listResourceSets,
  membershipRef,
} from './deploy'
import { extractResourceSetSpecs } from './validate'

/**
 * Detect drift between the deployed resource-set configuration and the live Okta
 * org. Each declared set is re-found by label and compared:
 *   - description
 *   - resource membership (order-insensitive) — read from the /resources sub-resource
 *
 * `label` is the identity (used to match) so it can never read as drift. Server-
 * managed readOnly fields (id, created, lastUpdated, _links) are never modeled.
 * Resource references are compared on their canonical ORN/URL form.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractResourceSetSpecs(ctx.deployedConfig).filter((s) => s.label && s.resources.length > 0)

  let liveSets
  try {
    liveSets = await listResourceSets(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'resource-sets',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    try {
      const live = findResourceSetByLabel(liveSets, spec.label)

      if (!live?.id) {
        diffs.push({ field: spec.label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // description
      const liveDescription = (live.description ?? '').toString()
      if (spec.description !== liveDescription) {
        diffs.push({
          field: `${spec.label}.description`,
          expected: spec.description || 'not set',
          actual: liveDescription || 'not set',
          severity: 'warning',
        })
      }

      // resource membership — order-insensitive, compared on canonical ORN/URL.
      // A desired reference in URL form may normalize to an ORN live, so count a
      // desired ref as present when it matches either the live ORN or REST URL.
      const memberships = await listResourceMemberships(client, live.id)
      const liveRefs = memberships.map(membershipRef).filter((r): r is string => !!r)
      const missing = spec.resources.filter(
        (ref) => !memberships.some((m) => m.orn === ref || m._links?.self?.href === ref),
      )
      const extra = memberships
        .filter((m) => {
          const orn = m.orn
          const href = m._links?.self?.href
          return !spec.resources.some((ref) => ref === orn || ref === href)
        })
        .map(membershipRef)
        .filter((r): r is string => !!r)

      if (missing.length > 0 || extra.length > 0) {
        diffs.push({
          field: `${spec.label}.resources`,
          expected: [...spec.resources].sort(),
          actual: [...liveRefs].sort(),
          severity: 'critical',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
