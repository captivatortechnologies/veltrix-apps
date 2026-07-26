import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { attachDriftActor, veltrixActorLogins } from '../lib/cyberarkAudit'
import { mapPlatforms } from './deploy'
import { extractPlatformSpecs, platformKey } from './validate'

/**
 * Detect drift between the deployed platform configuration and the live PVWA.
 * Re-finds each declared platform by PlatformID and diffs the managed active
 * state; a missing platform is critical drift.
 *
 * The GET /Platforms/Targets object carries no creator / modifier metadata and
 * there is no per-platform activity endpoint, so platform diffs cannot be
 * attributed with the app's credentials — attribution is wired uniformly (as for
 * safe members) but resolves no actor, so the drift view shows "—".
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPlatformSpecs(ctx.deployedConfig).filter((s) => s.platformId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const byKey = await mapPlatforms(client)

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(platformKey(spec))
      if (!found) {
        diffs.push({ field: spec.platformId, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.Active ?? false) !== spec.active) {
        diffs.push({
          field: `${spec.platformId}.active`,
          expected: spec.active,
          actual: found.Active ?? false,
          severity: 'warning',
        })
      }

      // Uniform attribution wiring; no resource/accountId is available for a
      // platform, so this resolves no actor (no extra API call).
      await attachDriftActor(client, diffs.slice(before), { excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}
