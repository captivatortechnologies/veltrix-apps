import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { compositeKey, extractNotificationTemplateSpecs, type LiveNotificationTemplate } from './validate'

const BASE = '/beta/notification-templates'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractNotificationTemplateSpecs(ctx.deployedConfig).filter((s) => s.key)
  const listed = await client.getAll<LiveNotificationTemplate>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByComposite = new Map<string, LiveNotificationTemplate>()
  for (const t of listed.items) {
    if (t.key && t.medium && t.locale) liveByComposite.set(compositeKey(t.key, t.medium, t.locale), t)
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const label = `${spec.key} (${spec.medium}/${spec.locale})`
    const live = liveByComposite.get(compositeKey(spec.key, spec.medium, spec.locale))
    if (!live) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.subject ?? '') !== spec.subject) {
      diffs.push({ field: `${label}.subject`, expected: spec.subject, actual: live.subject ?? '', severity: 'warning' })
    }
    if ((live.body ?? '') !== spec.body) {
      diffs.push({ field: `${label}.body`, expected: 'declared body', actual: 'differs', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
