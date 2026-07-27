import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import { extractAdminSpecs, type AdminSpec, type LiveAdmin } from './validate'

const BASE = '/admin/v1/admins'

export interface RollbackEntry {
  itemId?: string
  email: string
  /** Whether the admin existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Duo admin_id assigned to the administrator. */
  adminId?: string
  /** Prior name/role captured before an update so rollback can restore them. */
  prior?: { name: string; role: string }
}

/** Form params for create/modify. name and role are always sent so they reconcile. */
export function adminParams(spec: AdminSpec): Record<string, string> {
  return { name: spec.name, role: spec.role }
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
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractAdminSpecs(ctx.canvas).filter((s) => s.email)

  const listed = await client.getAll<LiveAdmin>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list administrators: ${duoErrorMessage(listed.lastError!)}` }
  }
  const liveByEmail = new Map<string, LiveAdmin>()
  const liveById = new Map<string, LiveAdmin>()
  for (const a of listed.items) {
    if (a.email) liveByEmail.set(a.email.toLowerCase(), a)
    if (a.admin_id) liveById.set(a.admin_id, a)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the id stored last deploy (email-change-safe), else match by email.
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.adminId ? liveById.get(priorEntry.adminId) : undefined) ??
      liveByEmail.get(spec.email) ??
      null

    if (liveMatch?.admin_id) {
      const resp = await client.post(`${BASE}/${liveMatch.admin_id}`, adminParams(spec))
      if (!resp.ok) {
        failures.push(`${spec.email}: ${duoErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        email: spec.email,
        existed: true,
        adminId: liveMatch.admin_id,
        prior: { name: liveMatch.name ?? '', role: liveMatch.role ?? '' },
      })
    } else {
      const resp = await client.post(BASE, { email: spec.email, ...adminParams(spec) })
      if (!resp.ok) {
        failures.push(`${spec.email}: ${duoErrorMessage(resp)}`)
        continue
      }
      const created = resp.response as LiveAdmin | null
      entries.push({ itemId: spec.itemId, email: spec.email, existed: false, adminId: created?.admin_id })
    }
  }

  // Reconcile: delete administrators THIS app created previously but no longer declares.
  const declaredEmails = new Set(specs.map((s) => s.email))
  const keptIds = new Set(entries.map((e) => e.adminId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.adminId && !keptIds.has(p.adminId) && !declaredEmails.has(p.email.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.adminId}`)
      if (!resp.ok) failures.push(`delete ${p.email}: ${duoErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some administrators failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} administrator(s)`, rollbackData: { entries } }
}
