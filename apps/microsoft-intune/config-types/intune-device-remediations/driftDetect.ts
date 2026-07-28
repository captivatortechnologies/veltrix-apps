import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { attachDriftActor, veltrixActorLogins } from '../../lib/intuneAuditLog'
import { type AssignmentSpec } from '../../lib/assignments'
import {
  decodeScript,
  hhmm,
  normalizeRunAsAccount,
  normalizeScript,
  readLiveAssignment,
  readLiveSchedule,
} from './remediation'
import { getRemediation, listRemediations } from './deploy'
import { extractRemediationSpecs, remediationKey } from './validate'

/** Order-insensitive comparison of two group-id sets. */
function sameGroups(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a.map((id) => id.toLowerCase()))
  return b.every((id) => set.has(id.toLowerCase()))
}

/** True when two assignment specs differ in any managed target. */
function assignmentsDiffer(want: AssignmentSpec, have: AssignmentSpec): boolean {
  return (
    !sameGroups(want.includeGroupIds, have.includeGroupIds) ||
    !sameGroups(want.excludeGroupIds, have.excludeGroupIds) ||
    Boolean(want.allDevices) !== Boolean(have.allDevices) ||
    Boolean(want.allUsers) !== Boolean(have.allUsers)
  )
}

/**
 * Detect drift between the deployed device remediations and the live tenant. A declared
 * remediation that no longer exists is critical drift; a managed field, script, schedule
 * or assignment that differs from the declared configuration is warning drift. Scripts are
 * compared as DECODED, whitespace-normalized text and read-only state is never compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractRemediationSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own app-only deploys appear under the app registration identity —
  // excluded so attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listRemediations(client)
    const byName = new Map(live.filter((r) => r.displayName && r.id).map((r) => [remediationKey(r.displayName as string), r]))

    for (const spec of specs) {
      const before = diffs.length
      const liveScript = byName.get(remediationKey(spec.name))
      if (!liveScript || !liveScript.id) {
        diffs.push({ field: `remediation:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await getRemediation(client, liveScript.id)
      if (!full) continue

      const liveDescription = typeof full.description === 'string' ? full.description : ''
      if (spec.description !== liveDescription) {
        diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription, severity: 'warning' })
      }

      const livePublisher = typeof full.publisher === 'string' ? full.publisher : ''
      if (spec.publisher !== livePublisher) {
        diffs.push({ field: `${spec.name}.publisher`, expected: spec.publisher, actual: livePublisher, severity: 'warning' })
      }

      const wantRunAs = normalizeRunAsAccount(spec.runAsAccount) || 'system'
      const haveRunAs = normalizeRunAsAccount(full.runAsAccount) || 'system'
      if (wantRunAs !== haveRunAs) {
        diffs.push({ field: `${spec.name}.runAsAccount`, expected: wantRunAs, actual: haveRunAs, severity: 'warning' })
      }

      if (spec.enforceSignatureCheck !== Boolean(full.enforceSignatureCheck)) {
        diffs.push({ field: `${spec.name}.enforceSignatureCheck`, expected: String(spec.enforceSignatureCheck), actual: String(Boolean(full.enforceSignatureCheck)), severity: 'warning' })
      }
      if (spec.runAs32Bit !== Boolean(full.runAs32Bit)) {
        diffs.push({ field: `${spec.name}.runAs32Bit`, expected: String(spec.runAs32Bit), actual: String(Boolean(full.runAs32Bit)), severity: 'warning' })
      }

      if (normalizeScript(spec.detectionScript) !== normalizeScript(decodeScript(full.detectionScriptContent))) {
        diffs.push({ field: `${spec.name}.detectionScript`, expected: 'as declared', actual: 'differs from declared', severity: 'warning' })
      }
      if (normalizeScript(spec.remediationScript) !== normalizeScript(decodeScript(full.remediationScriptContent))) {
        diffs.push({ field: `${spec.name}.remediationScript`, expected: 'as declared', actual: 'differs from declared', severity: 'warning' })
      }

      const haveSchedule = readLiveSchedule(full)
      if (spec.schedule.frequency !== haveSchedule.frequency) {
        diffs.push({ field: `${spec.name}.scheduleFrequency`, expected: spec.schedule.frequency, actual: haveSchedule.frequency, severity: 'warning' })
      }
      if (spec.schedule.interval !== haveSchedule.interval) {
        diffs.push({ field: `${spec.name}.scheduleInterval`, expected: spec.schedule.interval, actual: haveSchedule.interval, severity: 'warning' })
      }
      if (spec.schedule.frequency === 'daily' && haveSchedule.frequency === 'daily' && hhmm(spec.schedule.time) !== hhmm(haveSchedule.time)) {
        diffs.push({ field: `${spec.name}.scheduleTime`, expected: hhmm(spec.schedule.time), actual: hhmm(haveSchedule.time), severity: 'warning' })
      }

      if (assignmentsDiffer(spec.assignments, readLiveAssignment(full))) {
        diffs.push({ field: `${spec.name}.assignments`, expected: 'as declared', actual: 'differs from declared', severity: 'warning' })
      }

      // Attribute every diff this remediation produced to the last human change (once);
      // a no-op (no query) when the remediation did not drift.
      await attachDriftActor(client, diffs.slice(before), { targetId: liveScript.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'intune', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
