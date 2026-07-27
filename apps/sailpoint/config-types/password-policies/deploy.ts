import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractPasswordPolicySpecs, type LivePasswordPolicy, type PasswordPolicySpec } from './validate'

const BASE = '/v3/password-policies'

// Server-managed timestamps ISC rejects/ignores on write — dropped before a PUT.
const READ_ONLY_KEYS = ['dateCreated', 'lastUpdated', 'created', 'modified']

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  /** Full prior policy body (readOnly timestamps stripped) so rollback can restore it via PUT. */
  prior?: Record<string, unknown>
}

/** The rule fields this app owns — always sent so the policy is fully declarative. */
export function managedFields(spec: PasswordPolicySpec): Record<string, unknown> {
  return { description: spec.description, ...spec.numbers, ...spec.booleans }
}

function stripReadOnly(obj: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...obj }
  for (const k of READ_ONLY_KEYS) delete copy[k]
  return copy
}

export function createBody(spec: PasswordPolicySpec): Record<string, unknown> {
  return { name: spec.name, ...managedFields(spec) }
}

/** Full-replace body for PUT: preserve unmanaged live fields (sourceIds, defaultPolicy), override the managed rules. */
export function updateBody(live: LivePasswordPolicy, spec: PasswordPolicySpec): Record<string, unknown> {
  return { ...stripReadOnly(live as Record<string, unknown>), ...managedFields(spec), name: spec.name }
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

  const specs = extractPasswordPolicySpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LivePasswordPolicy>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list password policies: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LivePasswordPolicy>()
  const liveById = new Map<string, LivePasswordPolicy>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      // The tenant default password policy is protected — never overwrite it.
      if (live.defaultPolicy) {
        failures.push(`${spec.name}: this is the tenant default password policy and will not be modified`)
        continue
      }
      const resp = await client.put(`${BASE}/${live.id}`, updateBody(live, spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: stripReadOnly(live as Record<string, unknown>) })
    } else {
      const resp = await client.post(BASE, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LivePasswordPolicy>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete password policies THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some password policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} password policy(ies)`, rollbackData: { entries } }
}
