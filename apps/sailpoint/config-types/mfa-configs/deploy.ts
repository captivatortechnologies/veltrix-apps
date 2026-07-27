import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractMfaConfigSpecs, parseJsonObject, type LiveMfaConfig, type MfaConfigSpec } from './validate'

const configPath = (method: string): string => `/v3/mfa/${method}/config`
const deletePath = (method: string): string => `/v3/mfa/${method}/config/delete`

export interface RollbackEntry {
  itemId?: string
  method: string
  /** Whether the method was enabled BEFORE this deploy — controls safe revert. */
  priorEnabled: boolean
}

export function buildBody(spec: MfaConfigSpec, configProperties: Record<string, unknown>): Record<string, unknown> {
  return {
    mfaMethod: spec.method,
    enabled: spec.enabled,
    identityAttribute: spec.identityAttribute,
    configProperties,
  }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractMfaConfigSpecs(ctx.canvas).filter((s) => s.method)
  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseJsonObject(spec.configPropertiesRaw)
    if (!parsed.ok) {
      failures.push(`${spec.method}: ${parsed.error}`)
      continue
    }
    // Snapshot the prior enabled state so an undeclared/rolled-back method that
    // WAS disabled can be safely disabled again (secrets can't round-trip).
    const cur = await client.get(configPath(spec.method))
    const priorEnabled = cur.ok ? (parseJson<LiveMfaConfig>(cur.body)?.enabled ?? false) : false

    const resp = await client.put(configPath(spec.method), buildBody(spec, parsed.value))
    if (!resp.ok) {
      failures.push(`${spec.method}: ${iscErrorMessage(resp)}`)
      continue
    }
    entries.push({ itemId: spec.itemId, method: spec.method, priorEnabled })
  }

  // Reconcile: for methods THIS app enabled that were previously disabled and are
  // no longer declared, disable them again (delete the config).
  const declared = new Set(specs.map((s) => s.method))
  const kept = new Set(entries.map((e) => e.method))
  for (const p of prior) {
    if (!declared.has(p.method) && !kept.has(p.method) && !p.priorEnabled) {
      const resp = await client.delete(deletePath(p.method))
      if (!resp.ok && resp.status !== 404) failures.push(`disable ${p.method}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some MFA configs failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Applied ${entries.length} MFA method config(s)`, rollbackData: { entries } }
}
