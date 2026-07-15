import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findTrustedOrigin } from './deploy'
import { extractTrustedOriginSpecs, liveScopeTypes } from './validate'

/**
 * Detect drift between the deployed trusted-origin configuration and the live
 * Okta org. Each declared origin is re-found by name and its meaningful fields
 * are compared. Server-managed readOnly fields (id, created, lastUpdated, _links,
 * _embedded) are never modeled so they cannot read as drift; status is managed by
 * the lifecycle endpoints and is compared separately (warning).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTrustedOriginSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.origin && s.scopes.length > 0,
  )

  for (const spec of specs) {
    try {
      const live = await findTrustedOrigin(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // origin — the URL the trust applies to.
      const liveOrigin = (live.origin ?? '').toString()
      if (spec.origin !== liveOrigin) {
        diffs.push({
          field: `${spec.name}.origin`,
          expected: spec.origin,
          actual: liveOrigin || 'not set',
          severity: 'critical',
        })
      }

      // scopes — compare the set of granted scope types, order-independent.
      const expectedScopes = [...spec.scopes].sort()
      const actualScopes = liveScopeTypes(live)
      if (expectedScopes.join(',') !== actualScopes.join(',')) {
        diffs.push({
          field: `${spec.name}.scopes`,
          expected: expectedScopes,
          actual: actualScopes,
          severity: 'critical',
        })
      }

      // status — managed via lifecycle endpoints; compared separately (warning).
      const liveStatus = (live.status ?? '').toString().toUpperCase()
      const desiredStatus = (spec.status ?? '').toUpperCase()
      if (desiredStatus && liveStatus && desiredStatus !== liveStatus) {
        diffs.push({
          field: `${spec.name}.status`,
          expected: spec.status,
          actual: live.status ?? 'not set',
          severity: 'warning',
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
