import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import { getScript, listScripts } from './deploy'
import {
  DEFAULT_SCRIPT_FILE_NAME,
  decodeScriptContent,
  extractScriptSpecs,
  hasAnyAssignment,
  normalizeScript,
  scriptKey,
} from './validate'

/**
 * Detect drift between the deployed platform scripts and the live tenant. A declared
 * script that no longer exists is critical drift; a managed field, the (decoded)
 * script body, or an assignment that differs from the declared value is warning
 * drift. Only the fields this canvas declares are compared — server-managed state
 * (timestamps, run summaries) is never in the compare set, so it can never be
 * reported as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractScriptSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listScripts(client)
    const byName = new Map(live.filter((s) => s.displayName && s.id).map((s) => [scriptKey(s.displayName as string), s]))

    for (const spec of specs) {
      const before = diffs.length
      const liveScript = byName.get(scriptKey(spec.name))
      if (!liveScript || !liveScript.id) {
        diffs.push({ field: `script:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      const full = await getScript(client, liveScript.id)
      if (!full) continue

      const liveDescription = typeof full.description === 'string' ? full.description : ''
      if (spec.description !== liveDescription) {
        diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription, severity: 'warning' })
      }

      const wantFileName = spec.fileName || DEFAULT_SCRIPT_FILE_NAME
      const liveFileName = typeof full.fileName === 'string' ? full.fileName : ''
      if (wantFileName !== liveFileName) {
        diffs.push({ field: `${spec.name}.fileName`, expected: wantFileName, actual: liveFileName, severity: 'warning' })
      }

      const liveRunAs = typeof full.runAsAccount === 'string' ? full.runAsAccount : ''
      if (spec.runAsAccount !== liveRunAs) {
        diffs.push({ field: `${spec.name}.runAsAccount`, expected: spec.runAsAccount, actual: liveRunAs, severity: 'warning' })
      }

      if (spec.enforceSignatureCheck !== Boolean(full.enforceSignatureCheck)) {
        diffs.push({ field: `${spec.name}.enforceSignatureCheck`, expected: spec.enforceSignatureCheck, actual: Boolean(full.enforceSignatureCheck), severity: 'warning' })
      }

      if (spec.runAs32Bit !== Boolean(full.runAs32Bit)) {
        diffs.push({ field: `${spec.name}.runAs32Bit`, expected: spec.runAs32Bit, actual: Boolean(full.runAs32Bit), severity: 'warning' })
      }

      // Compare the DECODED script text (normalized) — never the base64 blob.
      if (normalizeScript(spec.scriptText) !== normalizeScript(decodeScriptContent(full.scriptContent))) {
        diffs.push({ field: `${spec.name}.scriptContent`, expected: 'as declared', actual: 'differs from declared', severity: 'warning' })
      }

      if (hasAnyAssignment(spec.assignments)) {
        const haveAssign = readAssignments(full.assignments)
        if (assignmentsDiffer(spec.assignments, haveAssign)) {
          diffs.push({ field: `${spec.name}.assignments`, expected: 'as declared', actual: 'differs from declared', severity: 'warning' })
        }
      }

      // Attribute every diff this script produced to the last human change (once);
      // a no-op (no query) when the script did not drift.
      await attachDriftActor(client, diffs.slice(before), { targetId: liveScript.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Order-insensitive comparison of declared vs live assignment targets. */
function assignmentsDiffer(
  want: AssignmentSpec,
  have: { includeGroupIds: string[]; excludeGroupIds: string[]; allDevices: boolean; allUsers: boolean },
): boolean {
  const norm = (ids: string[]): string[] => [...ids].map((id) => id.toLowerCase()).sort()
  const sameList = (a: string[], b: string[]): boolean => {
    const x = norm(a)
    const y = norm(b)
    return x.length === y.length && x.every((v, i) => v === y[i])
  }
  return (
    !sameList(want.includeGroupIds, have.includeGroupIds) ||
    !sameList(want.excludeGroupIds, have.excludeGroupIds) ||
    Boolean(want.allDevices) !== have.allDevices ||
    Boolean(want.allUsers) !== have.allUsers
  )
}
