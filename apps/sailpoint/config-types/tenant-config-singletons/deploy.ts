import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  IscClient,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractTenantConfigSpecs, parseJsonObject } from './validate'

interface Registry {
  path: string
  method: 'PUT' | 'PATCH'
}

/** Endpoint + write method per singleton. Keys mirror SETTINGS in validate.ts. */
export const REGISTRY: Record<string, Registry> = {
  'access-request-config': { path: '/v3/access-request-config', method: 'PUT' },
  'password-org-config': { path: '/v3/password-org-config', method: 'PUT' },
  'public-identities-config': { path: '/beta/public-identities-config', method: 'PUT' },
  'org-config': { path: '/beta/org-config', method: 'PATCH' },
  'auth-org-lockout': { path: '/v3/auth-org/lockout-config', method: 'PATCH' },
  'auth-org-session': { path: '/v3/auth-org/session-config', method: 'PATCH' },
  'auth-org-network': { path: '/v3/auth-org/network-config', method: 'PATCH' },
  'auth-org-service-provider': { path: '/v3/auth-org/service-provider-config', method: 'PATCH' },
}

export interface RollbackEntry {
  itemId?: string
  setting: string
  method: 'PUT' | 'PATCH'
  /** For PUT: the whole prior object. For PATCH: the prior values of the managed keys. */
  prior: Record<string, unknown>
}

function replaceOps(values: Record<string, unknown>): Array<Record<string, unknown>> {
  return Object.entries(values).map(([k, v]) => ({ op: 'replace', path: `/${k}`, value: v }))
}

/** Apply desired values, returning the prior snapshot to store for revert. */
async function applyConfig(
  client: IscClient,
  reg: Registry,
  desired: Record<string, unknown>
): Promise<{ ok: true; prior: Record<string, unknown> } | { ok: false; error: string }> {
  const cur = await client.get(reg.path)
  if (!cur.ok) return { ok: false, error: iscErrorMessage(cur) }
  const current = parseJson<Record<string, unknown>>(cur.body) ?? {}

  if (reg.method === 'PUT') {
    const resp = await client.put(reg.path, { ...current, ...desired })
    if (!resp.ok) return { ok: false, error: iscErrorMessage(resp) }
    return { ok: true, prior: current }
  }
  const resp = await client.patch(reg.path, replaceOps(desired))
  if (!resp.ok) return { ok: false, error: iscErrorMessage(resp) }
  const priorManaged: Record<string, unknown> = {}
  for (const k of Object.keys(desired)) priorManaged[k] = current[k]
  return { ok: true, prior: priorManaged }
}

/** Revert a singleton to a stored prior snapshot. */
export async function revertConfig(client: IscClient, reg: Registry, prior: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  if (reg.method === 'PUT') {
    const resp = await client.put(reg.path, prior)
    return resp.ok || resp.status === 404 ? { ok: true } : { ok: false, error: iscErrorMessage(resp) }
  }
  const resp = await client.patch(reg.path, replaceOps(prior))
  return resp.ok || resp.status === 404 ? { ok: true } : { ok: false, error: iscErrorMessage(resp) }
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

  const specs = extractTenantConfigSpecs(ctx.canvas).filter((s) => s.setting && REGISTRY[s.setting])
  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const reg = REGISTRY[spec.setting]
    const parsed = parseJsonObject(spec.configRaw)
    if (!parsed.ok) {
      failures.push(`${spec.setting}: ${parsed.error}`)
      continue
    }
    const applied = await applyConfig(client, reg, parsed.value)
    if (!applied.ok) {
      failures.push(`${spec.setting}: ${applied.error}`)
      continue
    }
    entries.push({ itemId: spec.itemId, setting: spec.setting, method: reg.method, prior: applied.prior })
  }

  // Reconcile: revert singletons this app previously configured but no longer declares.
  const declared = new Set(specs.map((s) => s.setting))
  const kept = new Set(entries.map((e) => e.setting))
  for (const p of prior) {
    if (!declared.has(p.setting) && !kept.has(p.setting) && REGISTRY[p.setting]) {
      const res = await revertConfig(client, REGISTRY[p.setting], p.prior)
      if (!res.ok) failures.push(`revert ${p.setting}: ${res.error}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some tenant settings failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Applied ${entries.length} tenant setting(s)`, rollbackData: { entries } }
}
