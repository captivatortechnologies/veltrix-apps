import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractNotificationTemplateSpecs, type LiveNotificationTemplate } from './validate'

const BASE = '/api/v1/tenant/notification-templates'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractNotificationTemplateSpecs(ctx.deployedConfig).filter((s) => s.name && !s.templateConfigError)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveNotificationTemplate[]>(res.body) ?? []
  const liveByName = new Map(live.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const t = liveByName.get(spec.name.toLowerCase())
    if (!t) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((t.integrationType ?? '') !== spec.integrationType) {
      diffs.push({ field: `${spec.name}.integrationType`, expected: spec.integrationType, actual: t.integrationType ?? '', severity: 'warning' })
    }
    if ((t.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(t.enabled ?? true), severity: 'warning' })
    }
    if (spec.integrationId && (t.integrationId ?? '') !== spec.integrationId) {
      diffs.push({ field: `${spec.name}.integrationId`, expected: spec.integrationId, actual: t.integrationId ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
