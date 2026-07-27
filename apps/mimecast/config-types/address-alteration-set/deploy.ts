import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import { extractAddressAlterationSetSpecs, setKey, type AddressAlterationSetSpec, type LiveSet } from './validate'

const CREATE = '/api/policy/address-alteration/create-address-alteration-set'
const GET_ALL = '/api/policy/address-alteration/get-address-alteration-set'

export interface RollbackEntry {
  itemId?: string
  /** the set description (its folder name). */
  name: string
  /** the parent set id ('' for root). */
  parentId: string
  /** whether a set with this identity existed BEFORE this app first managed it. */
  existed: boolean
  /** the set's secure id. */
  id?: string
}

/** Flatten a get-address-alteration-set response into every set (recursing folders). */
export function extractSets(data: unknown[]): LiveSet[] {
  const out: LiveSet[] = []
  const visit = (arr: LiveSet[] | undefined): void => {
    for (const s of arr ?? []) {
      if (!s || !s.id) continue
      out.push(s)
      if (Array.isArray(s.folders)) visit(s.folders)
    }
  }
  visit(data as LiveSet[])
  return out
}

/** Match a spec to a live set by (description + parent), falling back to name-only for root sets. */
function matchLive(spec: AddressAlterationSetSpec, live: LiveSet[]): LiveSet | null {
  const desc = spec.description.toLowerCase()
  if (spec.parentId) {
    return live.find((s) => (s.description ?? '').toLowerCase() === desc && s.parentId === spec.parentId) ?? null
  }
  return live.find((s) => (s.description ?? '').toLowerCase() === desc) ?? null
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
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildMimecastClient(cred, settings)

  const specs = extractAddressAlterationSetSpecs(ctx.canvas).filter((s) => s.description)

  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { success: false, message: `Failed to list address alteration sets: ${mimecastErrorMessage(listed)}` }
  const live = extractSets(listed.data)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(prior.map((e) => [setKey({ description: e.name, parentId: e.parentId }), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = setKey(spec)
    const found = matchLive(spec, live)
    const priorEntry = priorByKey.get(key)
    const existed = priorEntry ? priorEntry.existed : Boolean(found)

    if (found?.id) {
      entries.push({ itemId: spec.itemId, name: spec.description, parentId: spec.parentId, existed, id: found.id })
      continue
    }

    const payload: Record<string, unknown> = { description: spec.description }
    if (spec.parentId) payload.parentId = spec.parentId
    const resp = await client.request(CREATE, payload)
    if (!resp.ok) {
      failures.push(`${spec.description}: ${mimecastErrorMessage(resp)}`)
      continue
    }
    const created = resp.data[0] as { id?: string } | undefined
    entries.push({ itemId: spec.itemId, name: spec.description, parentId: spec.parentId, existed: false, id: created?.id })
  }

  // Address alteration sets have NO delete or update API — this is an
  // ensure-exists type: it creates sets it declares and NEVER prunes, so a
  // second deploy of the same spec is a no-op and nothing is ever removed.

  if (failures.length) {
    return { success: false, message: `Some address alteration sets failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Ensured ${entries.length} address alteration set(s)`, rollbackData: { entries } }
}
