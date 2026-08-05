import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractProfileObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import type { LiveUrlList } from '../url-lists/validate'
import { liveDestinationProfileId, type LiveDestinationProfile } from '../destination-profiles/validate'
import { extractCustomCategorySpecs, liveCustomCategoryId, type CustomCategorySpec, type LiveCustomCategory } from './validate'

const BASE = '/profiles/customcategories'
const URL_LISTS_BASE = '/policy/urllist'
const DESTINATION_PROFILES_BASE = '/profiles/destinations'

export interface CustomCategorySnapshot {
  name: string
  description: string
  included_predefined_categories: string[]
  included_url_lists: string[]
  excluded_url_lists: string[]
  included_destination_profiles: string[]
  excluded_destination_profiles: string[]
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: CustomCategorySnapshot
}

export function customCategoryBody(spec: CustomCategorySpec, urlListIds: { included: string[]; excluded: string[] }, destProfileIds: { included: string[]; excluded: string[] }): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    included_predefined_categories: spec.includedPredefinedCategories,
    included_url_lists: urlListIds.included,
    excluded_url_lists: urlListIds.excluded,
    included_destination_profiles: destProfileIds.included,
    excluded_destination_profiles: destProfileIds.excluded,
  }
}

function snapshotLive(live: LiveCustomCategory): CustomCategorySnapshot {
  return {
    name: live.name ?? '',
    description: live.description ?? '',
    included_predefined_categories: live.included_predefined_categories ?? [],
    included_url_lists: live.included_url_lists ?? [],
    excluded_url_lists: live.excluded_url_lists ?? [],
    included_destination_profiles: live.included_destination_profiles ?? [],
    excluded_destination_profiles: live.excluded_destination_profiles ?? [],
  }
}

/** Resolve declared names/ids against a live name->id map and a set of known ids. */
function resolveRefs(entries: string[], byName: Map<string, string>, byId: Set<string>): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = []
  const unresolved: string[] = []
  for (const entry of entries) {
    const id = byId.has(entry) ? entry : byName.get(entry.toLowerCase())
    if (id) resolved.push(id)
    else unresolved.push(entry)
  }
  return { resolved, unresolved }
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
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractCustomCategorySpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveCustomCategory>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list custom categories: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveCustomCategory>()
  const liveById = new Map<string, LiveCustomCategory>()
  for (const c of listed.items) {
    if (c.name) liveByName.set(c.name.toLowerCase(), c)
    const id = liveCustomCategoryId(c)
    if (id) liveById.set(id, c)
  }

  const urlLists = await client.getAll<LiveUrlList>(URL_LISTS_BASE)
  if (!urlLists.ok) return { success: false, message: `Failed to list URL lists: ${netskopeErrorMessage(urlLists.lastError!)}` }
  const urlListByName = new Map<string, string>()
  const urlListIds = new Set<string>()
  for (const l of urlLists.items) {
    if (l.id === undefined || l.id === null) continue
    const id = String(l.id)
    urlListIds.add(id)
    if (l.name) urlListByName.set(l.name.toLowerCase(), id)
  }

  const destProfiles = await client.getAll<LiveDestinationProfile>(DESTINATION_PROFILES_BASE)
  if (!destProfiles.ok) return { success: false, message: `Failed to list destination profiles: ${netskopeErrorMessage(destProfiles.lastError!)}` }
  const destProfileByName = new Map<string, string>()
  const destProfileIds = new Set<string>()
  for (const p of destProfiles.items) {
    const id = liveDestinationProfileId(p)
    if (!id) continue
    destProfileIds.add(id)
    if (p.name) destProfileByName.set(p.name.toLowerCase(), id)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const includedUrlLists = resolveRefs(spec.includedUrlLists, urlListByName, urlListIds)
    const excludedUrlLists = resolveRefs(spec.excludedUrlLists, urlListByName, urlListIds)
    const includedDestProfiles = resolveRefs(spec.includedDestinationProfiles, destProfileByName, destProfileIds)
    const excludedDestProfiles = resolveRefs(spec.excludedDestinationProfiles, destProfileByName, destProfileIds)
    const unresolved = [
      ...includedUrlLists.unresolved,
      ...excludedUrlLists.unresolved,
      ...includedDestProfiles.unresolved,
      ...excludedDestProfiles.unresolved,
    ]
    if (unresolved.length) {
      failures.push(`${spec.name}: unknown URL list / destination profile: ${unresolved.join(', ')}`)
      continue
    }

    const body = customCategoryBody(
      spec,
      { included: includedUrlLists.resolved, excluded: excludedUrlLists.resolved },
      { included: includedDestProfiles.resolved, excluded: excludedDestProfiles.resolved }
    )

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveCustomCategoryId(live) : undefined

    if (liveId) {
      const resp = await client.patch(`${BASE}/${liveId}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractProfileObject<LiveCustomCategory>(resp.body)
      const newId = created ? liveCustomCategoryId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete custom categories THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some custom categories failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} custom categor${entries.length === 1 ? 'y' : 'ies'}`, rollbackData: { entries } }
}
