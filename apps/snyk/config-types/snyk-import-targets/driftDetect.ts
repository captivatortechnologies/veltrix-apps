import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { listTargets } from './deploy'
import { extractImportTargetSpecs, targetDisplayName } from './validate'

/** Snyk audit event-name prefixes for target changes (best-effort attribution). */
const TARGET_EVENT_PREFIXES = ['org.target', 'org.project']

/**
 * Detect drift between the deployed import targets and the live org. A declared
 * target that no longer exists is critical drift (it was deleted). Import is
 * asynchronous, so a target requested very recently may not be listed yet — that
 * still surfaces as drift until the import completes.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractImportTargetSpecs(ctx.deployedConfig).filter((s) => s.owner && s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listTargets(client)
    const excludeActorLogins = veltrixActorLogins(ctx.credential)
    const names = new Set(
      live
        .map((t) => t.attributes?.display_name)
        .filter((d): d is string => typeof d === 'string')
        .map((d) => d.toLowerCase()),
    )

    for (const spec of specs) {
      const displayName = targetDisplayName(spec.owner, spec.name)
      if (!names.has(displayName.toLowerCase())) {
        const before = diffs.length
        diffs.push({ field: `target:${displayName}`, expected: 'exists', actual: 'missing', severity: 'critical' })

        // A declared target is gone (deleted) — attribute the removal. Best-effort.
        await attachDriftActor(client, diffs.slice(before), {
          targetName: displayName,
          eventPrefixes: TARGET_EVENT_PREFIXES,
          excludeActorLogins,
        })
      }
    }
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
