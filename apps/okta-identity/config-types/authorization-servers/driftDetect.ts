import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findAuthServer } from './deploy'
import { extractAuthServerSpecs } from './validate'

/**
 * Detect drift between the deployed authorization-server configuration and the
 * live Okta org. Each declared server is re-found by name and its MANAGED fields
 * are compared:
 *   - description, audiences, issuerMode — critical
 *   - status — warning (managed via the lifecycle endpoints)
 *
 * Server-managed readOnly fields (id, created, lastUpdated, issuer, credentials,
 * _links, _embedded, system) are never modelled so they cannot read as drift.
 * issuerMode is only compared when authored, so Okta's own default does not read
 * as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAuthServerSpecs(ctx.deployedConfig).filter((s) => s.name && s.audiences.length === 1)

  for (const spec of specs) {
    try {
      const live = await findAuthServer(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // description — managed, returned on read.
      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'critical',
        })
      }

      // audiences — the token audience set (exactly one authored). Normalise so
      // key order / whitespace do not read as drift.
      const expectedAudiences = [...spec.audiences].sort()
      const liveAudiences = (Array.isArray(live.audiences) ? live.audiences.map(String) : []).sort()
      if (stableStringify(expectedAudiences) !== stableStringify(liveAudiences)) {
        diffs.push({
          field: `${spec.name}.audiences`,
          expected: expectedAudiences.join(', ') || 'not set',
          actual: liveAudiences.join(', ') || 'not set',
          severity: 'critical',
        })
      }

      // issuerMode — only compared when authored (Okta defaults it otherwise).
      if (spec.issuerMode) {
        const liveIssuerMode = (typeof live.issuerMode === 'string' ? live.issuerMode : '').toUpperCase()
        if (spec.issuerMode !== liveIssuerMode) {
          diffs.push({
            field: `${spec.name}.issuerMode`,
            expected: spec.issuerMode,
            actual: liveIssuerMode || 'not set',
            severity: 'critical',
          })
        }
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

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
