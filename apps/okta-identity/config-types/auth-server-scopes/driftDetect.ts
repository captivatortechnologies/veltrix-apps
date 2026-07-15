import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findScope } from './deploy'
import { extractScopeSpecs } from './validate'

/**
 * Detect drift between the deployed scope configuration and the live Okta org.
 * Each declared scope is re-found by (authServerId, name) and its authored
 * fields are compared:
 *   - displayName, description, consent, default, metadataPublish, optional
 * Server-managed readOnly fields (id, created, lastUpdated, system, _links,
 * _embedded) are never modeled so they cannot read as drift. A live
 * `system: true` scope is not something this app authors, so it is skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractScopeSpecs(ctx.deployedConfig).filter((s) => s.authServerId && s.name)

  for (const spec of specs) {
    const label = `${spec.authServerId}:${spec.name}`
    try {
      const live = await findScope(client, spec.authServerId, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // A built-in system scope is not managed by this app — never diff it.
      if (live.system === true) continue

      // displayName — authored, returned on read.
      const liveDisplayName = (typeof live.displayName === 'string' ? live.displayName : '').trim()
      if ((spec.displayName ?? '') !== liveDisplayName) {
        diffs.push({
          field: `${label}.displayName`,
          expected: spec.displayName ?? 'not set',
          actual: liveDisplayName || 'not set',
          severity: 'warning',
        })
      }

      // description — authored, returned on read.
      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'warning',
        })
      }

      // consent — REQUIRED | IMPLICIT | FLEXIBLE.
      const liveConsent = (typeof live.consent === 'string' ? live.consent : '').toUpperCase()
      if (spec.consent !== liveConsent) {
        diffs.push({
          field: `${label}.consent`,
          expected: spec.consent,
          actual: liveConsent || 'not set',
          severity: 'critical',
        })
      }

      // metadataPublish — ALL_CLIENTS | NO_CLIENTS.
      const liveMetadata = (typeof live.metadataPublish === 'string' ? live.metadataPublish : '').toUpperCase()
      if (spec.metadataPublish !== liveMetadata) {
        diffs.push({
          field: `${label}.metadataPublish`,
          expected: spec.metadataPublish,
          actual: liveMetadata || 'not set',
          severity: 'critical',
        })
      }

      // default — boolean flag.
      const liveDefault = live.default === true
      if (spec.default !== liveDefault) {
        diffs.push({
          field: `${label}.default`,
          expected: spec.default,
          actual: liveDefault,
          severity: 'warning',
        })
      }

      // optional — boolean flag.
      const liveOptional = live.optional === true
      if (spec.optional !== liveOptional) {
        diffs.push({
          field: `${label}.optional`,
          expected: spec.optional,
          actual: liveOptional,
          severity: 'warning',
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
