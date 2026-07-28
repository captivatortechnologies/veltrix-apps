import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import { isBuiltInScopeTag, listScopeTags, type LiveScopeTag } from './deploy'
import { extractScopeTagSpecs, scopeTagKey, type ScopeTagSpec } from './validate'

/** Push a warning diff when a declared string field differs from the live value (trim-insensitive). */
function pushFieldDiff(diffs: DriftDiff[], name: string, field: string, expected: string, actual: string): void {
  if (expected.trim() !== actual.trim()) {
    diffs.push({ field: `${name}.${field}`, expected: expected || '(empty)', actual: actual || '(empty)', severity: 'warning' })
  }
}

/** Compare a declared scope tag to its live counterpart (name is the key, so only description can drift). */
function compareScopeTag(diffs: DriftDiff[], spec: ScopeTagSpec, live: LiveScopeTag): void {
  pushFieldDiff(diffs, spec.name, 'description', spec.description, live.description ?? '')
}

/**
 * Detect drift between the deployed role scope tags and the live tenant. A declared
 * tag that no longer exists is critical drift; a differing description is warning
 * drift. A declared tag that resolves to the built-in Default tag is never managed,
 * so it is skipped (no drift reported for it).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractScopeTagSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listScopeTags(client)
    const byName = new Map(live.filter((t) => t.displayName && t.id).map((t) => [scopeTagKey(t.displayName as string), t]))

    for (const spec of specs) {
      const before = diffs.length
      const liveTag = byName.get(scopeTagKey(spec.name))
      if (!liveTag || !liveTag.id) {
        diffs.push({ field: `scopeTag:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      // The built-in Default tag is managed by Intune — never report drift for it.
      if (isBuiltInScopeTag(liveTag)) continue

      compareScopeTag(diffs, spec, liveTag)
      // Attribute every diff this tag produced to the last human change (once);
      // a no-op (no query) when the tag did not drift.
      await attachDriftActor(client, diffs.slice(before), { targetId: liveTag.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
