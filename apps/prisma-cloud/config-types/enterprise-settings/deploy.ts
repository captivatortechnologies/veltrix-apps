import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import { extractEnterpriseSettingsSpecs, buildOverlay } from './validate'

const BASE = '/settings/enterprise'

export interface RollbackEntry {
  /** the full prior settings snapshot, restored verbatim on rollback. */
  prior: Record<string, unknown>
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractEnterpriseSettingsSpecs(ctx.canvas).filter((s) => !s.defaultPoliciesError)
  const spec = specs[0]
  if (!spec) return { success: true, message: 'No enterprise settings declared' }

  const overlay = buildOverlay(spec)
  if (Object.keys(overlay).length === 0) {
    return { success: true, message: 'No enterprise settings fields set — nothing to apply' }
  }

  // Singleton-patch: read current, overlay only declared fields, PUT.
  const getRes = await client.get(BASE)
  if (!getRes.ok) return { success: false, message: `Failed to read enterprise settings: ${pcErrorMessage(getRes)}` }
  const current = parseJson<Record<string, unknown>>(getRes.body) ?? {}

  const putRes = await client.put(BASE, { ...current, ...overlay })
  if (!putRes.ok) return { success: false, message: `Failed to update enterprise settings: ${pcErrorMessage(putRes)}` }

  const entry: RollbackEntry = { prior: current }
  return { success: true, message: `Applied ${Object.keys(overlay).length} enterprise setting(s)`, rollbackData: { entries: [entry] } }
}
