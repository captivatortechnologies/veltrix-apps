import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  effectiveUniqueName,
  extractApplicationSpecs,
  hasText,
  parseJsonArray,
  stripAppRoleReadOnly,
  type ApplicationSpec,
  type LiveApplication,
} from './validate'
import { buildOwnerPrincipalNameMaps, resolveOwnerPrincipals } from '../lib/principals'
import { reconcileRefCollection, type RefMemberEntry } from '../lib/refReconcile'

const BASE = '/applications'
/** Trim the live projection to just the managed fields (never secrets). */
const SELECT =
  '?$select=id,displayName,uniqueName,signInAudience,identifierUris,web,spa,appRoles,requiredResourceAccess,groupMembershipClaims,tags'
/** Header that turns a PATCH-by-alternate-key into a create-or-update upsert. */
const UPSERT_HEADERS = { Prefer: 'create-if-missing' }

export interface RollbackEntry {
  itemId?: string
  name: string
  /** The immutable uniqueName this app is keyed by (empty for legacy apps). */
  uniqueName: string
  /** Whether the app existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior managed fields, captured before an update so rollback can restore them.
   *  Never includes secrets. */
  prior?: Record<string, unknown>
  /** Tracked owners, with provenance — see RefMemberEntry. */
  owners?: RefMemberEntry[]
}

/** OData alternate-key literals escape a single quote by doubling it. */
function odataKey(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Body for POST/PATCH — only the managed fields, and only those the author
 * actually declared. uniqueName is never sent (read-only; set via the URL key).
 * A blank list/JSON field is omitted so unmanaged portal settings (homePageUrl,
 * implicit grant, auto-assigned identifierUris, …) are left untouched.
 */
export function buildBody(spec: ApplicationSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    displayName: spec.name,
    signInAudience: spec.signInAudience,
  }
  if (spec.redirectUris.length) body.web = { redirectUris: spec.redirectUris }
  if (spec.spaRedirectUris.length) body.spa = { redirectUris: spec.spaRedirectUris }
  if (spec.identifierUris.length) body.identifierUris = spec.identifierUris
  if (spec.tags.length) body.tags = spec.tags
  if (spec.groupMembershipClaims) body.groupMembershipClaims = spec.groupMembershipClaims
  if (hasText(spec.appRoles)) {
    const roles = parseJsonArray(spec.appRoles)
    // Strip the read-only appRole `origin` before writing — an author who pastes
    // an exported appRoles array would otherwise send it (Graph ignores/rejects it,
    // and it must stay out of writes to match drift + the rollback snapshot).
    if (roles) body.appRoles = stripAppRoleReadOnly(roles as Record<string, unknown>[])
  }
  if (hasText(spec.requiredResourceAccess)) {
    const rra = parseJsonArray(spec.requiredResourceAccess)
    if (rra) body.requiredResourceAccess = rra
  }
  return body
}

/** Snapshot the managed fields of a live app so rollback can restore them. */
function snapshotLive(live: LiveApplication): Record<string, unknown> {
  return {
    displayName: live.displayName ?? null,
    signInAudience: live.signInAudience ?? null,
    web: { redirectUris: live.web?.redirectUris ?? [] },
    spa: { redirectUris: live.spa?.redirectUris ?? [] },
    identifierUris: live.identifierUris ?? [],
    tags: live.tags ?? [],
    groupMembershipClaims: live.groupMembershipClaims ?? null,
    appRoles: stripAppRoleReadOnly(live.appRoles ?? []),
    requiredResourceAccess: live.requiredResourceAccess ?? [],
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
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractApplicationSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveApplication>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list applications: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByUniqueName = new Map<string, LiveApplication>()
  const liveById = new Map<string, LiveApplication>()
  for (const a of listed.items) {
    if (a.uniqueName) liveByUniqueName.set(a.uniqueName.toLowerCase(), a)
    if (a.id) liveById.set(a.id, a)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByUnique = new Map(prior.filter((e) => e.uniqueName).map((e) => [e.uniqueName.toLowerCase(), e]))

  // Owner references resolve against users/service principals — a
  // picker-selected value passes straight through; a hand-typed display
  // name/UPN (pre-picker convention) falls back to these live maps.
  const ownerMaps = await buildOwnerPrincipalNameMaps(client)

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  // Every uniqueName this deploy DECLARES (regardless of per-item success), so the
  // reconcile below never deletes a still-declared app just because its update
  // transiently failed this run.
  const declaredUnique = new Set<string>()

  for (const spec of specs) {
    // Prefer the uniqueName we assigned on a prior deploy so a displayName rename
    // still updates the same (immutably-keyed) application.
    const priorEntry =
      (spec.itemId && priorByItemId.get(spec.itemId)) ||
      priorByUnique.get(effectiveUniqueName(spec).toLowerCase())
    const uniqueName = priorEntry?.uniqueName || effectiveUniqueName(spec)
    declaredUnique.add(uniqueName.toLowerCase())

    // Match ONLY by our own keys (prior id, then the immutable uniqueName). A
    // displayName fallback is deliberately NOT used: displayName is not unique in
    // Entra, so it would adopt and PATCH an unrelated pre-existing registration.
    // An app we created always carries our uniqueName, so the upsert-by-uniqueName
    // path below handles create/update without touching a same-named look-alike.
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ??
      liveByUniqueName.get(uniqueName.toLowerCase()) ??
      null

    const body = buildBody(spec)
    let appId: string | undefined
    let entry: RollbackEntry

    if (liveMatch?.id) {
      // Update. Use the declarative upsert primitive when this app carries our
      // uniqueName; fall back to update-by-id for legacy apps without one.
      const useKey = liveMatch.uniqueName && liveMatch.uniqueName.toLowerCase() === uniqueName.toLowerCase()
      const resp = useKey
        ? await client.request('PATCH', `${BASE}(uniqueName='${odataKey(liveMatch.uniqueName!)}')`, body, {
            headers: UPSERT_HEADERS,
          })
        : await client.patch(`${BASE}/${liveMatch.id}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      appId = liveMatch.id
      entry = {
        itemId: spec.itemId,
        name: spec.name,
        uniqueName: liveMatch.uniqueName || uniqueName,
        // Sticky provenance: if a prior deploy created this app (existed:false),
        // keep it marked created so a later removal still cleans it up. `existed`
        // is otherwise re-derived from live state and would flip to true after one
        // deploy, orphaning the app.
        existed: priorEntry?.existed === false ? false : true,
        id: liveMatch.id,
        prior: snapshotLive(liveMatch),
      }
    } else {
      // Create-or-update by the uniqueName alternate key (Prefer: create-if-missing).
      const resp = await client.request('PATCH', `${BASE}(uniqueName='${odataKey(uniqueName)}')`, body, {
        headers: UPSERT_HEADERS,
      })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveApplication>(resp.body)
      appId = created?.id
      entry = {
        itemId: spec.itemId,
        name: spec.name,
        uniqueName,
        existed: false,
        id: created?.id,
      }
    }

    if (appId) {
      const ownerResolution = resolveOwnerPrincipals(spec.owners, ownerMaps)
      if (ownerResolution.missing.length) {
        failures.push(
          `${spec.name}: unknown owner(s) ${ownerResolution.missing.join(', ')} — create/verify them first or fix the name`
        )
        // Leave ownership exactly as last tracked — don't touch Graph until every owner resolves.
        entry.owners = priorEntry?.owners ?? []
      } else {
        const { members, failures: ownerFailures } = await reconcileRefCollection(
          client,
          `${BASE}/${appId}`,
          'owners',
          ownerResolution.ids,
          priorEntry?.owners ?? []
        )
        entry.owners = members
        for (const f of ownerFailures) failures.push(`${spec.name}: ${f}`)
      }
    }

    entries.push(entry)
  }

  // Reconcile: delete apps THIS config created previously but no longer declares.
  // `declaredUnique` is built from the SPECS (above), not from successful entries,
  // so a transient update failure can never turn into a delete of a declared app.
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredUnique.has(p.uniqueName.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some applications failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} application registration(s)`,
    rollbackData: { entries },
  }
}
