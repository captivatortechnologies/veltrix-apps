import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findLinkedObject } from './deploy'
import { extractLinkedObjectSpecs } from './validate'

/**
 * Detect drift between the deployed linked-object definitions and the live Okta
 * org. Each declared definition is re-found by its PRIMARY name and its
 * meaningful fields are compared:
 *   - a missing definition is critical
 *   - a changed associated NAME is critical (it redefines the relationship)
 *   - a changed title or description is a warning
 * Server-managed fields (_links, type) are never modeled so they cannot read as
 * drift; the primary name is the match key, so it is never itself a diff.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractLinkedObjectSpecs(ctx.deployedConfig).filter((s) => s.primaryName && s.associatedName)

  for (const spec of specs) {
    try {
      const live = await findLinkedObject(client, spec.primaryName)

      if (!live) {
        diffs.push({ field: spec.primaryName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const primary = live.primary ?? {}
      const associated = live.associated ?? {}

      // primary title — a display-name change is a warning.
      if ((primary.title ?? '') !== spec.primaryTitle) {
        diffs.push({
          field: `${spec.primaryName}.primaryTitle`,
          expected: spec.primaryTitle,
          actual: primary.title ?? 'not set',
          severity: 'warning',
        })
      }

      // primary description — a warning.
      if ((primary.description ?? '') !== (spec.primaryDescription ?? '')) {
        diffs.push({
          field: `${spec.primaryName}.primaryDescription`,
          expected: spec.primaryDescription ?? 'not set',
          actual: primary.description ?? 'not set',
          severity: 'warning',
        })
      }

      // associated NAME — redefines the relationship, so this is critical.
      if ((associated.name ?? '').trim().toLowerCase() !== spec.associatedName.toLowerCase()) {
        diffs.push({
          field: `${spec.primaryName}.associatedName`,
          expected: spec.associatedName,
          actual: associated.name ?? 'not set',
          severity: 'critical',
        })
      }

      // associated title — a warning.
      if ((associated.title ?? '') !== spec.associatedTitle) {
        diffs.push({
          field: `${spec.primaryName}.associatedTitle`,
          expected: spec.associatedTitle,
          actual: associated.title ?? 'not set',
          severity: 'warning',
        })
      }

      // associated description — a warning.
      if ((associated.description ?? '') !== (spec.associatedDescription ?? '')) {
        diffs.push({
          field: `${spec.primaryName}.associatedDescription`,
          expected: spec.associatedDescription ?? 'not set',
          actual: associated.description ?? 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.primaryName,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
