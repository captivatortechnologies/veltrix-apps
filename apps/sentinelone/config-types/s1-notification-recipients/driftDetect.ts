import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { attachDriftActor, veltrixActorLogins } from '../../lib/s1ActivityLog'
import { listRecipients } from './deploy'
import { extractRecipientSpecs, recipientKey, type LiveRecipient } from './validate'

/**
 * Detect drift between the deployed notification recipient configuration and
 * the live scope. Re-finds each declared recipient by email and diffs the
 * managed fields; a missing recipient is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasScope || client.currentScope === 'group') return { hasDrift: false, diffs: [] }

  const specs = extractRecipientSpecs(ctx.deployedConfig).filter((s) => s.email)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listRecipients(client)
    const byKey = new Map<string, LiveRecipient>(live.filter((r) => r.email).map((r) => [recipientKey(r.email as string), r]))

    const veltrixLogins = veltrixActorLogins(ctx.credential)
    const attributions: Array<Promise<void>> = []

    for (const spec of specs) {
      const label = spec.email
      const before = diffs.length
      const found = byKey.get(recipientKey(spec.email))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else {
        const liveName = (typeof found.name === 'string' ? found.name : '').trim()
        if ((spec.name ?? '') !== liveName) {
          diffs.push({ field: `${label}.name`, expected: spec.name ?? 'not set', actual: liveName || 'not set', severity: 'info' })
        }
        const liveSms = (typeof found.sms === 'string' ? found.sms : '').trim()
        if ((spec.sms ?? '') !== liveSms) {
          diffs.push({ field: `${label}.sms`, expected: spec.sms ?? 'not set', actual: liveSms || 'not set', severity: 'info' })
        }
      }

      const objectDiffs = diffs.slice(before)
      if (objectDiffs.length > 0) {
        attributions.push(
          attachDriftActor(client, objectDiffs, {
            targetId: found?.id,
            targetName: spec.email,
            excludeActorLogins: veltrixLogins,
          }),
        )
      }
    }
    await Promise.all(attributions)
  } catch (error) {
    diffs.push({
      field: 'sentinelone',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
