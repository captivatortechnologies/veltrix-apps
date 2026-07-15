import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, cloudflareResult } from '../../lib/cloudflare'
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

  try {
    for (const spec of specs) {
      const id = settingKey(spec.settingId)
      const res = await client.zone('GET', `/settings/${id}`)
      if (!res.ok) {
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
