import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractIntegrationSpecs, type LiveIntegration } from './validate'
import { integrationConfigBody } from './deploy'

const BASE = '/integrations'

type Diffs = DriftResult['diffs']

function stable(v: Record<string, unknown>): string {
  return JSON.stringify(v, Object.keys(v).sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractIntegrationSpecs(ctx.deployedConfig).filter((s) => s.name && s.integrationType)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveIntegration[]>(res.body) ?? []
  const liveByName = new Map(live.filter((i) => i.name).map((i) => [i.name!.toLowerCase(), i]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const it = liveByName.get(spec.name.toLowerCase())
    if (!it) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((it.integrationType ?? '') !== spec.integrationType) {
      diffs.push({
        field: `${spec.name}.integrationType`,
        expected: spec.integrationType,
        actual: it.integrationType ?? '',
        severity: 'critical',
      })
      continue // type mismatch makes the config comparison below meaningless
    }
    if (((it.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (it.description ?? '') as string, severity: 'warning' })
    }
    if ((it.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(it.enabled ?? true), severity: 'warning' })
    }
    const declaredCfg = integrationConfigBody(spec)
    const liveCfg = it.integrationConfig ?? {}
    if (stable(declaredCfg) !== stable(liveCfg)) {
      diffs.push({ field: `${spec.name}.integrationConfig`, expected: JSON.stringify(declaredCfg), actual: JSON.stringify(liveCfg), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
