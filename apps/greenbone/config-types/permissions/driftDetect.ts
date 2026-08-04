import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetPermissionsCommand, parsePermissions } from '../../lib/gmp/permissions'
import { extractSpecs, loadPriorEntries } from './_shared'

/** Detect drift between the last-deployed permission set and live gvmd state, tracked by canvas-item id. Read-only. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential || !credential.username || !credential.password) return { hasDrift: false, diffs }

  const specs = extractSpecs(items).filter((s) => s.itemId && s.name && s.subjectId)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const prior = await loadPriorEntries(ctx.platform, canvas)
  const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

  let live
  try {
    live = await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component), timeoutMs: 8000 },
      { username: credential.username, password: credential.password },
      async (session) => parsePermissions(await session.send(buildGetPermissionsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs: [{ field: 'greenbone', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const liveById = new Map(live.map((p) => [p.id, p]))

  for (const spec of specs) {
    const label = `${spec.name} (${spec.itemId})`
    const tracked = priorByItemId.get(spec.itemId)
    if (!tracked) {
      diffs.push({ field: label, expected: 'tracked', actual: 'never deployed', severity: 'warning' })
      continue
    }

    const found = liveById.get(tracked.permissionId)
    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (found.name !== spec.name) diffs.push({ field: `${label}.name`, expected: spec.name, actual: found.name, severity: 'critical' })
    if (found.subjectId !== spec.subjectId) diffs.push({ field: `${label}.subjectId`, expected: spec.subjectId, actual: found.subjectId, severity: 'critical' })
    if (found.subjectType !== spec.subjectType) diffs.push({ field: `${label}.subjectType`, expected: spec.subjectType, actual: found.subjectType, severity: 'critical' })
    if ((spec.resourceId ?? '') !== found.resourceId) diffs.push({ field: `${label}.resourceId`, expected: spec.resourceId ?? '', actual: found.resourceId, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
