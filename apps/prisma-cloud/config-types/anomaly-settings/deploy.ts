import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import { extractAnomalySettingsSpecs, buildOverlay, type LiveAnomalySettings } from './validate'

const BASE = '/anomalies/settings'

export interface RollbackEntry {
  policyId: string
  prior: { alertDisposition: string; trainingModelThreshold: string }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractAnomalySettingsSpecs(ctx.canvas).filter((s) => s.policyId)

  // One call reads every built-in anomaly policy's current settings.
  const getRes = await client.get(BASE)
  if (!getRes.ok) return { success: false, message: `Failed to read anomaly settings: ${pcErrorMessage(getRes)}` }
  const all = parseJson<Record<string, LiveAnomalySettings>>(getRes.body) ?? {}

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  let applied = 0

  for (const spec of specs) {
    const current = all[spec.policyId]
    if (!current) {
      failures.push(`${spec.policyId}: unknown or inaccessible anomaly policy id`)
      continue
    }

    const overlay = buildOverlay(spec)
    if (Object.keys(overlay).length === 0) continue // no-op item — nothing declared to apply

    const putRes = await client.post(`${BASE}/${encodeURIComponent(spec.policyId)}`, overlay)
    if (!putRes.ok) {
      failures.push(`${spec.policyId}: ${pcErrorMessage(putRes)}`)
      continue
    }

    entries.push({
      policyId: spec.policyId,
      prior: {
        alertDisposition: current.alertDisposition ?? '',
        trainingModelThreshold: current.trainingModelThreshold ?? '',
      },
    })
    applied++
  }

  if (failures.length) {
    return { success: false, message: `Some anomaly settings failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Applied ${applied} anomaly setting(s)`, rollbackData: { entries } }
}
