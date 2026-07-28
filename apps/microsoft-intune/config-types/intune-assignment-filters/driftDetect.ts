import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import { listAssignmentFilters, type LiveFilter } from './deploy'
import { canonicalPlatform, extractFilterSpecs, filterKey, type FilterSpec } from './validate'

/** Push a warning diff when a declared string field differs from the live value (trim-insensitive). */
function pushFieldDiff(diffs: DriftDiff[], name: string, field: string, expected: string, actual: string): void {
  if (expected.trim() !== actual.trim()) {
    diffs.push({ field: `${name}.${field}`, expected: expected || '(empty)', actual: actual || '(empty)', severity: 'warning' })
  }
}

/** Compare a declared filter to its live counterpart, appending a diff per differing field. */
function compareFilter(diffs: DriftDiff[], spec: FilterSpec, live: LiveFilter): void {
  pushFieldDiff(diffs, spec.name, 'description', spec.description, live.description ?? '')
  pushFieldDiff(diffs, spec.name, 'rule', spec.rule, live.rule ?? '')

  const wantType = spec.managementType || 'devices'
  const haveType = live.assignmentFilterManagementType ?? 'devices'
  if (wantType.toLowerCase() !== haveType.toLowerCase()) {
    diffs.push({ field: `${spec.name}.managementType`, expected: wantType, actual: haveType, severity: 'warning' })
  }

  const wantPlatform = canonicalPlatform(spec.platform) || spec.platform
  const havePlatform = live.platform ?? ''
  if (wantPlatform.toLowerCase() !== havePlatform.toLowerCase()) {
    diffs.push({ field: `${spec.name}.platform`, expected: wantPlatform, actual: havePlatform || '(empty)', severity: 'warning' })
  }
}

/**
 * Detect drift between the deployed assignment filters and the live tenant. A
 * declared filter that no longer exists is critical drift; a differing
 * description / rule / platform / management type is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractFilterSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAssignmentFilters(client)
    const byName = new Map(live.filter((f) => f.displayName && f.id).map((f) => [filterKey(f.displayName as string), f]))

    for (const spec of specs) {
      const before = diffs.length
      const liveFilter = byName.get(filterKey(spec.name))
      if (!liveFilter || !liveFilter.id) {
        diffs.push({ field: `filter:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      compareFilter(diffs, spec, liveFilter)
      // Attribute every diff this filter produced to the last human change (once);
      // a no-op (no query) when the filter did not drift.
      await attachDriftActor(client, diffs.slice(before), { targetId: liveFilter.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
