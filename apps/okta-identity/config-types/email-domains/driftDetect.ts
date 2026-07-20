import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findEmailDomain } from './deploy'
import { extractEmailDomainSpecs } from './validate'

/**
 * Detect drift between the deployed email-domain configuration and the live Okta
 * org. Each declared domain is re-found by name and its fields are compared:
 *   - displayName / userName        — updatable, so a difference is a WARNING
 *   - brandId / validationSubdomain — IMMUTABLE, so a difference is CRITICAL
 *   - validationStatus              — a status other than VERIFIED/COMPLETED is a
 *                                     WARNING (the operator still owes Okta the DNS
 *                                     verify handshake)
 *
 * Runtime-only fields (dnsValidationRecords, _links) are never modeled so they
 * cannot read as drift. Immutable fields are only compared when the live domain
 * actually returns them, so an unreturned field never reads as false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractEmailDomainSpecs(ctx.deployedConfig).filter((s) => s.domain)

  for (const spec of specs) {
    try {
      const live = await findEmailDomain(client, spec.domain)

      if (!live) {
        diffs.push({ field: spec.domain, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // displayName — updatable in place, so a difference is a warning.
      const liveDisplay = (live.displayName ?? '').toString()
      if (liveDisplay !== spec.displayName) {
        diffs.push({
          field: `${spec.domain}.displayName`,
          expected: spec.displayName,
          actual: liveDisplay || 'not set',
          severity: 'warning',
        })
      }

      // userName — updatable in place, so a difference is a warning.
      const liveUser = (live.userName ?? '').toString()
      if (liveUser !== spec.userName) {
        diffs.push({
          field: `${spec.domain}.userName`,
          expected: spec.userName,
          actual: liveUser || 'not set',
          severity: 'warning',
        })
      }

      // brandId — IMMUTABLE; a difference is critical. Only compared when the live
      // domain returns it.
      const liveBrand = (live.brandId ?? '').toString().trim()
      if (liveBrand && liveBrand !== spec.brandId) {
        diffs.push({
          field: `${spec.domain}.brandId`,
          expected: spec.brandId,
          actual: liveBrand,
          severity: 'critical',
        })
      }

      // validationSubdomain — IMMUTABLE; a difference is critical.
      const liveSub = (live.validationSubdomain ?? '').toString().trim()
      if (liveSub && liveSub.toLowerCase() !== spec.validationSubdomain.toLowerCase()) {
        diffs.push({
          field: `${spec.domain}.validationSubdomain`,
          expected: spec.validationSubdomain,
          actual: liveSub,
          severity: 'critical',
        })
      }

      // validationStatus — an unverified domain still owes the DNS handshake.
      const liveStatus = (live.validationStatus ?? '').toString().toUpperCase()
      if (liveStatus && liveStatus !== 'VERIFIED' && liveStatus !== 'COMPLETED') {
        diffs.push({
          field: `${spec.domain}.validationStatus`,
          expected: 'VERIFIED',
          actual: liveStatus,
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.domain,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
