import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractTagSpecs, findTag, parseAssignments, resolveEntityId } from './_shared'
import { listEntityTags, listTags, loadEntityLookups } from './deploy'

/**
 * Detect drift between the deployed tags configuration and the live PagerDuty
 * account. Re-finds each declared tag by its `label`:
 *   - a missing tag is CRITICAL drift
 *   - a declared assignment whose entity no longer carries the tag is WARNING drift
 *
 * Assignment checks are best-effort: an entity that can no longer be resolved by
 * name/email, or a per-entity /tags read that fails, is skipped rather than
 * reported — this app never asserts drift from a failed lookup, only from a
 * confirmed mismatch (see escalation-policies/driftDetect.ts for the same rule).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractTagSpecs(ctx.deployedConfig).filter((s) => s.label)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listTags(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read tags, no drift asserted
  }

  let lookups
  try {
    lookups = await loadEntityLookups(client)
  } catch {
    lookups = null // best-effort: assignment checks are skipped below when this fails
  }

  for (const spec of specs) {
    const match = findTag(live, spec.label)
    if (!match || !match.id) {
      diffs.push({ field: spec.label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    if (!lookups) continue

    const parsed = parseAssignments(spec.assignmentsJson)
    if (!parsed.assignments) continue

    for (const assignment of parsed.assignments) {
      const entityId = resolveEntityId(assignment.entity_type, assignment.entity_name, lookups)
      if (!entityId) continue // entity no longer resolvable by name/email — best-effort skip

      try {
        const entityTags = await listEntityTags(client, assignment.entity_type, entityId)
        if (!entityTags.some((t) => t.id === match.id)) {
          diffs.push({
            field: `${spec.label}.${assignment.entity_type}:${assignment.entity_name}`,
            expected: 'tagged',
            actual: 'not tagged',
            severity: 'warning',
          })
        }
      } catch {
        continue // best-effort: this entity's tag list could not be read
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
