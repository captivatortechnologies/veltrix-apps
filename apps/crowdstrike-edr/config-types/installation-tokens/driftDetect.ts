import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { deriveRevoked, findTokenByLabel, liveExpiry, type LiveToken } from './deploy'
import { extractInstallationTokenSpecs, type InstallationTokenSpec } from './validate'

/**
 * Detect drift between the deployed installation token configuration and the
 * live tenant state. Looks up each declared token by label and diffs the managed
 * fields — expiry and revoke state. The token SECRET (`value`) is never read or
 * compared; it is not part of the managed configuration.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractInstallationTokenSpecs(ctx.deployedConfig).filter((s) => s.label)

  for (const spec of specs) {
    const label = spec.label
    const before = diffs.length
    try {
      const live = await findTokenByLabel(client, spec.label)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffToken(spec, live))

      // Attribute every diff this token produced to Falcon's recorded last
      // modifier (once). Installation tokens do not currently expose a modifier
      // field, so this is a no-op today — wired for consistency with the other
      // config types and forward-compatibility if Falcon adds one.
      attachDriftActor(diffs.slice(before), tokenActorResource(live), { excludeActorLogins })
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

/** Bridge a token's (currently absent) modifier fields onto the audit reader shape. */
function tokenActorResource(live: LiveToken): ModifiedResource {
  return { modified_by: live.modified_by, modified_timestamp: live.modified_timestamp }
}

function diffToken(spec: InstallationTokenSpec, live: LiveToken): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.label

  // Revoke state decides whether the token can install sensors — most consequential.
  const liveRevoked = deriveRevoked(live)
  if (liveRevoked !== spec.revoked) {
    diffs.push({
      field: `${label}.revoked`,
      expected: spec.revoked,
      actual: liveRevoked,
      severity: 'critical',
    })
  }

  const specExpiry = spec.expiresTimestamp
  const actualExpiry = liveExpiry(live)
  if (!sameExpiry(specExpiry, actualExpiry)) {
    diffs.push({
      field: `${label}.expiresTimestamp`,
      expected: specExpiry || 'never',
      actual: actualExpiry || 'never',
      severity: 'warning',
    })
  }

  return diffs
}

/** Compare expiries by instant; both empty means "never" on each side (equal). */
function sameExpiry(a: string, b: string): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  const parsedA = Date.parse(a)
  const parsedB = Date.parse(b)
  if (Number.isNaN(parsedA) || Number.isNaN(parsedB)) return a === b
  return parsedA === parsedB
}
