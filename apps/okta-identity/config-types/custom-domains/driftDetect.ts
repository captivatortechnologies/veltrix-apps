import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findCustomDomain } from './deploy'
import { extractCustomDomainSpecs } from './validate'

/**
 * Detect drift between the last-deployed custom-domain configuration and the
 * live Okta org. Each declared domain is re-found by name and compared against
 * what THIS APP deployed (not the current canvas edit) — an out-of-band change
 * made directly in Okta is what counts as drift:
 *   - missing                    — CRITICAL
 *   - certificateSourceType      — CRITICAL (e.g. someone switched a domain to
 *                                  a MANUAL certificate directly in Okta; there
 *                                  is no API to revert that, so it needs an
 *                                  operator decision, not a silent re-deploy)
 *   - brandId                    — WARNING (updatable in place via redeploy)
 *   - validationStatus           — WARNING when not VERIFIED/COMPLETED (the
 *                                  operator still owes Okta the DNS handshake)
 *
 * Certificate material (certificate/certificateChain/privateKey) is WRITE-ONLY
 * — Okta never returns it, so it can never be diffed and is never modeled here.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCustomDomainSpecs(ctx.deployedConfig).filter((s) => s.domain)

  for (const spec of specs) {
    try {
      const live = await findCustomDomain(client, spec.domain)

      if (!live) {
        diffs.push({ field: spec.domain, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // certificateSourceType — an out-of-band switch to/from MANUAL is
      // critical; Okta has no API to revert MANUAL back to OKTA_MANAGED.
      const liveSource = (live.certificateSourceType ?? '').toString().toUpperCase()
      if (liveSource && liveSource !== spec.certificateSourceType) {
        diffs.push({
          field: `${spec.domain}.certificateSourceType`,
          expected: spec.certificateSourceType,
          actual: liveSource,
          severity: 'critical',
        })
      }

      // brandId — updatable in place, so a difference is a warning.
      const liveBrand = (live.brandId ?? '').toString().trim()
      if (spec.brandId && liveBrand && liveBrand !== spec.brandId) {
        diffs.push({
          field: `${spec.domain}.brandId`,
          expected: spec.brandId,
          actual: liveBrand,
          severity: 'warning',
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
