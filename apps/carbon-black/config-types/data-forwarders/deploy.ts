import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type CbClient,
} from '../../lib/carbonblack'
import { extractForwarderSpecs, type ForwarderSpec, type LiveForwarder } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  /** the original pre-management forwarder body, so rollback can recreate it. */
  prior?: Record<string, unknown>
}

/** The create/update body for a forwarder (destination-conditional fields only). */
export function buildBody(spec: ForwarderSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    type: spec.type,
    destination: spec.destination,
    enabled: spec.enabled,
  }
  if (spec.versionConstraint) body.version_constraint = spec.versionConstraint
  if (spec.destination === 'aws_s3') {
    body.s3_bucket_name = spec.s3BucketName
    if (spec.s3Prefix) body.s3_prefix = spec.s3Prefix
  } else if (spec.destination === 'azure_blob_storage') {
    body.azure_storage_account = spec.azureStorageAccount
    body.azure_container_name = spec.azureContainerName
    if (spec.azureTenantId) body.azure_tenant_id = spec.azureTenantId
    if (spec.azureClientId) body.azure_client_id = spec.azureClientId
  } else if (spec.destination === 'gcs_bucket') {
    body.gcs_bucket_name = spec.gcsBucketName
    if (spec.gcsPrefix) body.gcs_prefix = spec.gcsPrefix
  }
  return body
}

export function snapshotLive(live: LiveForwarder): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  for (const k of [
    'name', 'type', 'destination', 'enabled', 'version_constraint',
    's3_bucket_name', 's3_prefix',
    'azure_storage_account', 'azure_container_name', 'azure_tenant_id', 'azure_client_id',
    'gcs_bucket_name', 'gcs_prefix',
  ] as const) {
    if (live[k] !== undefined) b[k] = live[k]
  }
  return b
}

/** `type` and `destination` are immutable — a change forces delete+recreate. */
export function immutableChanged(live: LiveForwarder, spec: ForwarderSpec): boolean {
  return (live.type ?? '') !== spec.type || (live.destination ?? '') !== spec.destination
}

/** Whether a live forwarder already equals the desired spec (name matches). */
export function definitionEquals(live: LiveForwarder, spec: ForwarderSpec): boolean {
  if (immutableChanged(live, spec)) return false
  if ((live.enabled ?? true) !== spec.enabled) return false
  if ((live.version_constraint ?? '') !== spec.versionConstraint) return false
  if (spec.destination === 'aws_s3') {
    return (live.s3_bucket_name ?? '') === spec.s3BucketName && (live.s3_prefix ?? '') === spec.s3Prefix
  }
  if (spec.destination === 'azure_blob_storage') {
    return (live.azure_storage_account ?? '') === spec.azureStorageAccount && (live.azure_container_name ?? '') === spec.azureContainerName
  }
  if (spec.destination === 'gcs_bucket') {
    return (live.gcs_bucket_name ?? '') === spec.gcsBucketName && (live.gcs_prefix ?? '') === spec.gcsPrefix
  }
  return true
}

async function listForwarders(client: CbClient, base: string): Promise<{ ok: boolean; items: LiveForwarder[]; err?: string }> {
  const res = await client.get(base)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveForwarder[] } | LiveForwarder[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  return { ok: true, items }
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
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const base = client.dataForwardersPath()

  const specs = extractForwarderSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await listForwarders(client, base)
  if (!listed.ok) return { success: false, message: `Failed to list data forwarders: ${listed.err}` }
  const liveByName = new Map<string, LiveForwarder>()
  const liveById = new Map<string, LiveForwarder>()
  for (const f of listed.items) {
    if (f.name) liveByName.set(f.name.toLowerCase(), f)
    if (f.id) liveById.set(f.id, f)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map<string, RollbackEntry>()
  for (const p of prior) if (p.itemId) priorByItem.set(p.itemId, p)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the prior-stored id (rename-safe) so a renamed forwarder updates in
    // place; otherwise fall back to matching the live set by name.
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live =
      (priorEntry?.id && liveById.get(priorEntry.id)) ||
      liveByName.get(spec.name.toLowerCase()) ||
      null

    const existed = priorEntry ? priorEntry.existed : !!live
    const priorSnap = priorEntry ? priorEntry.prior : live ? snapshotLive(live) : undefined

    if (live?.id && definitionEquals(live, spec)) {
      entries.push({ itemId: spec.itemId, name: spec.name, existed, id: live.id, prior: priorSnap })
      continue
    }

    if (live?.id && immutableChanged(live, spec)) {
      // type/destination can't be updated — delete then recreate.
      const del = await client.delete(`${base}/${live.id}`)
      if (!del.ok && del.status !== 404) {
        failures.push(`${spec.name}: ${cbErrorMessage(del)}`)
        continue
      }
      const resp = await client.post(base, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveForwarder>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed, id: created?.id, prior: priorSnap })
      continue
    }

    if (live?.id) {
      const updated = await client.put(`${base}/${live.id}`, buildBody(spec))
      if (!updated.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(updated)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed, id: live.id, prior: priorSnap })
    } else {
      const resp = await client.post(base, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveForwarder>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete forwarders THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const del = await client.delete(`${base}/${p.id}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.name}: ${cbErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some data forwarders failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} data forwarder(s)`, rollbackData: { entries } }
}
