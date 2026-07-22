import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { readSastSettings } from './deploy'
import { extractSastSettings } from './validate'

/** Snyk audit event-name prefixes for org SAST/settings changes (best-effort attribution). */
const SAST_EVENT_PREFIXES = ['org.sast_settings', 'org.settings']

/**
 * Detect drift between the deployed SAST settings and the live org: compare the
 * live sast_enabled to the deployed value.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const spec = extractSastSettings(ctx.deployedConfig)

  try {
    const live = await readSastSettings(client)
    const liveEnabled = live?.sast_enabled ?? false
    if (liveEnabled !== spec.sastEnabled) {
      diffs.push({
        field: 'sast_enabled',
        expected: String(spec.sastEnabled),
        actual: String(liveEnabled),
        severity: 'warning',
      })
    }

    // Org-singleton: attribute the SAST setting change ("who changed it + when") — best-effort.
    await attachDriftActor(client, diffs, {
      eventPrefixes: SAST_EVENT_PREFIXES,
      excludeActorLogins: veltrixActorLogins(ctx.credential),
    })
  } catch (error) {
    diffs.push({
      field: 'snyk',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
