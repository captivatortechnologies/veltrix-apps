import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, cloudflareResult } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { extractZoneSettingSpecs, normalizeSettingValue, settingKey, type LiveSetting } from './validate'

/**
 * Detect drift between the deployed zone settings and the live zone. Re-reads
 * each declared setting (GET /settings/{id}) and diffs its value against the
 * configured one. Settings always exist, so the only drift is a changed value
 * (or an unreadable setting).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractZoneSettingSpecs(ctx.deployedConfig).filter((s) => s.settingId && s.value)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    for (const spec of specs) {
      const before = diffs.length
      const id = settingKey(spec.settingId)
      const res = await client.zone('GET', `/settings/${id}`)
      if (!res.ok) {
        // A transient read error, not a human change — do not attribute.
        diffs.push({
          field: spec.settingId,
          expected: spec.value,
          actual: `unreadable: ${cloudflareErrorMessage(res)}`,
          severity: 'warning',
        })
        continue
      }
      const live = normalizeSettingValue(cloudflareResult<LiveSetting>(res)?.value)
      if (live !== spec.value) {
        diffs.push({
          field: `${spec.settingId}.value`,
          expected: spec.value,
          actual: live || 'not set',
          severity: 'warning',
        })
      }
      // Attribute a changed setting value to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: id, targetName: spec.settingId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
