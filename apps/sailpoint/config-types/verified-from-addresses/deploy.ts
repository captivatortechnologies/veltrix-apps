import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractVerifiedFromAddressSpecs, type LiveVerifiedFromAddress } from './validate'

const BASE = '/beta/verified-from-addresses'

export interface RollbackEntry {
  itemId?: string
  email: string
  existed: boolean
  id?: string
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

  const specs = extractVerifiedFromAddressSpecs(ctx.canvas).filter((s) => s.email)

  const listed = await client.getAll<LiveVerifiedFromAddress>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list verified from-addresses: ${iscErrorMessage(listed.lastError!)}` }
  const liveByEmail = new Map<string, LiveVerifiedFromAddress>()
  for (const a of listed.items) {
    if (a.email) liveByEmail.set(a.email.toLowerCase(), a)
  }

  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const live = liveByEmail.get(spec.email.toLowerCase()) ?? null
    if (live?.id) {
      // Already present — no update possible; record it and leave verification as-is.
      entries.push({ itemId: spec.itemId, email: spec.email, existed: true, id: live.id })
    } else {
      const resp = await client.post(BASE, { email: spec.email })
      if (!resp.ok) {
        failures.push(`${spec.email}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveVerifiedFromAddress>(resp.body)
      entries.push({ itemId: spec.itemId, email: spec.email, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete addresses THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => s.email.toLowerCase()))
  const keptEmails = new Set(entries.map((e) => e.email.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && p.id && !keptEmails.has(p.email.toLowerCase()) && !declared.has(p.email.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.email}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some verified from-addresses failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} verified from-address(es)`, rollbackData: { entries } }
}
