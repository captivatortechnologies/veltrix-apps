import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/carbonblack'
import {
  extractOverrideSpecs,
  liveNaturalKey,
  naturalKey,
  type LiveOverride,
  type OverrideSpec,
} from './validate'

export interface RollbackEntry {
  itemId?: string
  /** the natural key (type + identifying value). */
  name: string
  /** Whether an override with this key existed BEFORE this app first managed it. */
  existed: boolean
  /** the current CBC override id representing this key. */
  id?: string
  /** the original pre-management body, so rollback can recreate it. */
  prior?: Record<string, unknown>
}

export function buildBody(spec: OverrideSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { override_list: spec.overrideList, override_type: spec.overrideType }
  if (spec.description) body.description = spec.description
  if (spec.overrideType === 'SHA256') {
    body.sha256_hash = spec.sha256Hash.toLowerCase()
    if (spec.filename) body.filename = spec.filename
  } else if (spec.overrideType === 'CERT') {
    body.signed_by = spec.signedBy
    if (spec.certificateAuthority) body.certificate_authority = spec.certificateAuthority
  } else if (spec.overrideType === 'IT_TOOL') {
    body.path = spec.path
    body.include_child_processes = spec.includeChildProcesses
  }
  return body
}

export function snapshotLive(live: LiveOverride): Record<string, unknown> {
  const b: Record<string, unknown> = { override_list: live.override_list, override_type: live.override_type }
  for (const k of ['sha256_hash', 'filename', 'signed_by', 'certificate_authority', 'path', 'include_child_processes', 'description'] as const) {
    if (live[k] !== undefined) b[k] = live[k]
  }
  return b
}

/** Whether a live override already equals the desired spec (natural key matches). */
export function definitionEquals(live: LiveOverride, spec: OverrideSpec): boolean {
  if ((live.override_list ?? '') !== spec.overrideList) return false
  if ((live.description ?? '') !== spec.description) return false
  if (spec.overrideType === 'SHA256') return (live.filename ?? '') === spec.filename
  if (spec.overrideType === 'CERT') return (live.certificate_authority ?? '') === spec.certificateAuthority
  if (spec.overrideType === 'IT_TOOL') return (live.include_child_processes ?? false) === spec.includeChildProcesses
  return true
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
  const base = client.overridesPath()

  const specs = extractOverrideSpecs(ctx.canvas).filter((s) => s.label)

  const listed = await client.searchAll<LiveOverride>()
  if (!listed.ok) {
    return { success: false, message: `Failed to list reputation overrides: ${cbErrorMessage(listed.lastError!)}` }
  }
  const liveByKey = new Map<string, LiveOverride>()
  for (const o of listed.items) liveByKey.set(liveNaturalKey(o), o)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(prior.map((e) => [e.name, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = naturalKey(spec)
    const live = liveByKey.get(key) ?? null
    const priorEntry = priorByKey.get(key)

    // Carry the original pre-management state forward across deploys.
    let existed: boolean
    let priorSnap: Record<string, unknown> | undefined
    if (priorEntry) {
      existed = priorEntry.existed
      priorSnap = priorEntry.prior
    } else if (live) {
      existed = true
      priorSnap = snapshotLive(live)
    } else {
      existed = false
      priorSnap = undefined
    }

    if (live?.id && definitionEquals(live, spec)) {
      // Already correct — keep it.
      entries.push({ itemId: spec.itemId, name: key, existed, id: live.id, prior: priorSnap })
      continue
    }

    // No update API — delete the wrong/old one (if any) and create the desired.
    if (live?.id) {
      const del = await client.delete(`${base}/${live.id}`)
      if (!del.ok && del.status !== 404) {
        failures.push(`${spec.label}: ${cbErrorMessage(del)}`)
        continue
      }
    }
    const resp = await client.post(base, buildBody(spec))
    if (!resp.ok) {
      failures.push(`${spec.label}: ${cbErrorMessage(resp)}`)
      continue
    }
    const created = parseJson<LiveOverride>(resp.body)
    entries.push({ itemId: spec.itemId, name: key, existed, id: created?.id, prior: priorSnap })
  }

  // Reconcile: delete overrides THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => naturalKey(s)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredKeys.has(p.name)) {
      const del = await client.delete(`${base}/${p.id}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.name}: ${cbErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some overrides failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} reputation override(s)`, rollbackData: { entries } }
}
