import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractAnomalySettingsSpecs, type LiveAnomalySettings } from './validate'

const BASE = '/anomalies/settings'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractAnomalySettingsSpecs(ctx.deployedConfig).filter((s) => s.policyId && (s.alertDisposition || s.trainingModelThreshold))
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const all = parseJson<Record<string, LiveAnomalySettings>>(res.body) ?? {}

  const diffs: Diffs = []
  for (const spec of specs) {
    const current = all[spec.policyId]
    if (!current) {
      diffs.push({ field: spec.policyId, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.alertDisposition && (current.alertDisposition ?? '') !== spec.alertDisposition) {
      diffs.push({
        field: `${spec.policyId}.alertDisposition`,
        expected: spec.alertDisposition,
        actual: current.alertDisposition ?? '',
        severity: 'warning',
      })
    }
    if (spec.trainingModelThreshold && (current.trainingModelThreshold ?? '') !== spec.trainingModelThreshold) {
      diffs.push({
        field: `${spec.policyId}.trainingModelThreshold`,
        expected: spec.trainingModelThreshold,
        actual: current.trainingModelThreshold ?? '',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
