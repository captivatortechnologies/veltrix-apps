import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, parseJson } from '../../lib/xrayApi'
import { webhookPath } from './deploy'
import { extractWebhookSpecs, type XrayWebhook } from './_shared'
import { stringMapsEqual } from '../../lib/fields'

/**
 * Detect drift between the last-deployed webhook configuration and the live
 * Xray tenant. Re-reads each declared webhook by name (`GET
 * /api/v1/webhooks/{name}`) and compares description/url/use_proxy/user_name/
 * headers. Deliberately does NOT compare `password` — a write-only secret
 * that a read response may not echo back, so no meaningful comparison is
 * possible (see README Coverage notes). Best-effort and read-only: any
 * transport failure reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractWebhookSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  for (const spec of specs) {
    const res = await client.request('GET', webhookPath(spec.name))
    if (!res.ok) {
      if (res.status === 404) diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    const live = parseJson<XrayWebhook>(res.body)
    if (!live) continue

    const liveDescription = live.description ?? ''
    const desiredDescription = spec.description ?? ''
    if (desiredDescription !== liveDescription) {
      diffs.push({ field: `${spec.name}.description`, expected: desiredDescription || '(none)', actual: liveDescription || '(none)', severity: 'warning' })
    }
    if (spec.url !== (live.url ?? '')) {
      diffs.push({ field: `${spec.name}.url`, expected: spec.url, actual: live.url ?? '(none)', severity: 'warning' })
    }
    const liveUseProxy = live.use_proxy ?? false
    if (spec.useProxy !== liveUseProxy) {
      diffs.push({ field: `${spec.name}.use_proxy`, expected: String(spec.useProxy), actual: String(liveUseProxy), severity: 'warning' })
    }
    const desiredUserName = spec.userName ?? ''
    const liveUserName = live.user_name ?? ''
    if (desiredUserName !== liveUserName) {
      diffs.push({ field: `${spec.name}.user_name`, expected: desiredUserName || '(none)', actual: liveUserName || '(none)', severity: 'warning' })
    }
    if (!stringMapsEqual(spec.headers, live.headers ?? {})) {
      diffs.push({
        field: `${spec.name}.headers`,
        expected: JSON.stringify(spec.headers),
        actual: JSON.stringify(live.headers ?? {}),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
