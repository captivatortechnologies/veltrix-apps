import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MimecastClient,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import {
  definitionKey,
  extractAddressAlterationDefinitionSpecs,
  liveDefinitionKey,
  type AddressAlterationDefinitionSpec,
  type LiveDefinition,
} from './validate'

const CREATE = '/api/policy/address-alteration/create-definition'
const GET = '/api/policy/address-alteration/get-definition'
const DELETE = '/api/policy/address-alteration/delete-definition'

export interface RollbackEntry {
  itemId?: string
  /** the definition natural key (rule tuple). */
  name: string
  /** whether a definition with this tuple existed BEFORE this app first managed it. */
  existed: boolean
  /** the definition's secure id. */
  id?: string
}

export function buildPayload(spec: AddressAlterationDefinitionSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    addressAlterations: [
      {
        routing: spec.routing,
        addressType: spec.addressType,
        originalAddress: spec.originalAddress,
        newAddress: spec.newAddress,
      },
    ],
  }
  if (spec.folderId) payload.folderId = spec.folderId
  return payload
}

/**
 * Look up the live definition matching a spec's full tuple. get-definition
 * requires at least one criterion, so we query with the rule fields it accepts
 * (folderId/routing/originalAddress/newAddress) then confirm addressType on the
 * returned rows.
 */
export async function findDefinition(
  client: MimecastClient,
  spec: AddressAlterationDefinitionSpec,
): Promise<LiveDefinition | null> {
  const query: Record<string, unknown> = {
    routing: spec.routing,
    originalAddress: spec.originalAddress,
    newAddress: spec.newAddress,
  }
  if (spec.folderId) query.folderId = spec.folderId
  const resp = await client.request(GET, query)
  if (!resp.ok) return null
  const want = definitionKey(spec)
  return (resp.data as LiveDefinition[]).find((d) => liveDefinitionKey(d) === want) ?? null
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

  const specs = extractAddressAlterationDefinitionSpecs(ctx.canvas).filter((s) => s.originalAddress && s.newAddress)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(prior.map((e) => [e.name, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = definitionKey(spec)
    let live = await findDefinition(client, spec)
    const priorEntry = priorByKey.get(key)
    const existed = priorEntry ? priorEntry.existed : Boolean(live)

    if (!live) {
      const resp = await client.request(CREATE, buildPayload(spec))
      if (!resp.ok) {
        failures.push(`${spec.originalAddress}->${spec.newAddress}: ${mimecastErrorMessage(resp)}`)
        continue
      }
      // The create response id shape varies; re-read the authoritative id by tuple.
      live = await findDefinition(client, spec)
    }

    entries.push({ itemId: spec.itemId, name: key, existed, id: live?.id })
  }

  // Reconcile: delete definitions THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => definitionKey(s)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredKeys.has(p.name)) {
      const del = await client.request(DELETE, { id: p.id })
      if (!del.ok) failures.push(`delete ${p.name}: ${mimecastErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some address alteration definitions failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} address alteration definition(s)`, rollbackData: { entries } }
}
