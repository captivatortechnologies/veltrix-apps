import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import { extractB2xUserFlowSpecs, resultingId, type B2xUserFlowSpec, type LiveB2xUserFlow } from './validate'
import { buildIdNameMap, resolveByIdOrNameMany, type IdNameMap } from '../lib/nameMaps'
import { reconcileRefCollection, type RefMemberEntry } from '../lib/refReconcile'

const BASE = '/identity/b2xUserFlows'

export interface RollbackEntry {
  itemId?: string
  /** The resulting (prefixed) flow id. */
  name: string
  existed: boolean
  id?: string
  /** Tracked identityProvider assignments, with provenance — see RefMemberEntry. */
  identityProviders?: RefMemberEntry[]
  /** Tracked identityUserFlowAttributeAssignment sub-resources, with provenance. */
  attributes?: RefMemberEntry[]
}

/** POST body — the flow is create-only (no update); userFlowType is fixed. */
export function buildCreateBody(spec: B2xUserFlowSpec): Record<string, unknown> {
  return { id: spec.id, userFlowType: 'signUpOrSignIn', userFlowTypeVersion: spec.userFlowTypeVersion }
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

/** identityUserFlowAttribute metadata needed to build an assignment body (displayName is
 *  required by the create operation; dataType picks a sensible default userInputType). */
export interface AttributeMeta {
  displayName: string
  dataType?: string
}

/** id-or-name resolution map for user flow attributes, plus the metadata needed to assign them. */
export interface AttributeMaps extends IdNameMap {
  metaById: Map<string, AttributeMeta>
}

/** Build the identityUserFlowAttribute id/name/metadata maps once per deploy run. */
export async function buildAttributeMaps(client: GraphClient): Promise<AttributeMaps> {
  const idsLower = new Map<string, string>()
  const nameToId = new Map<string, string>()
  const metaById = new Map<string, AttributeMeta>()
  const listed = await client.getAll<{ id?: string; displayName?: string; dataType?: string }>(
    '/identity/userFlowAttributes?$select=id,displayName,dataType'
  )
  if (listed.ok) {
    for (const a of listed.items) {
      if (!a.id) continue
      idsLower.set(a.id.toLowerCase(), a.id)
      if (a.displayName) nameToId.set(a.displayName.toLowerCase(), a.id)
      metaById.set(a.id, { displayName: a.displayName ?? a.id, dataType: a.dataType })
    }
  }
  return { idsLower, nameToId, metaById }
}

/** Graph documents six userInputType values with no stated dataType mapping
 *  (https://learn.microsoft.com/graph/api/resources/identityuserflowattributeassignment)
 *  — textBox is the universal safe default; dateTime attributes get the one
 *  obviously-matching alternative. */
function defaultUserInputType(dataType: string | undefined): string {
  return dataType === 'dateTime' ? 'dateTimeDropdown' : 'textBox'
}

/** GET the current attribute-assignment ids on a flow (paginated). The assignment's
 *  own id equals the underlying attribute's id — confirmed by Graph's worked example
 *  (POSTing userAttribute:{id:"extension_guid_shoeSize"} returns id:"extension_guid_shoeSize",
 *  https://learn.microsoft.com/graph/api/b2xidentityuserflow-post-userattributeassignments). */
async function listAttributeAssignmentIds(client: GraphClient, flowId: string): Promise<{ ok: boolean; ids: Set<string> }> {
  const listed = await client.getAll<{ id?: string }>(`${BASE}/${flowId}/userAttributeAssignments?$select=id`)
  const ids = new Set<string>()
  if (listed.ok) {
    for (const a of listed.items) if (a.id) ids.add(a.id)
  }
  return { ok: listed.ok, ids }
}

/**
 * Reconcile a flow's userAttributeAssignments to the declared attribute set.
 *
 * Unlike identityProviders/appliesTo/owners elsewhere in this app, this is NOT
 * a $ref collection — each assignment is a full identityUserFlowAttributeAssignment
 * sub-resource created via POST {flow}/userAttributeAssignments (required
 * properties: isOptional, requiresVerification, userInputType, displayName,
 * userAttributeValues, userAttribute — see
 * https://learn.microsoft.com/graph/api/b2xidentityuserflow-post-userattributeassignments)
 * and removed via a real DELETE {flow}/userAttributeAssignments/{id}, not a
 * $ref delete. Only removes assignments THIS app itself added (existed:false)
 * that are no longer declared, mirroring the $ref reconciles' "never delete
 * what we didn't add" rule.
 */
export async function reconcileAttributeAssignments(
  client: GraphClient,
  flowId: string,
  desired: Array<{ id: string; meta: AttributeMeta }>,
  priorEntries: RefMemberEntry[]
): Promise<{ entries: RefMemberEntry[]; failures: string[] }> {
  const live = await listAttributeAssignmentIds(client, flowId)
  if (!live.ok) {
    return { entries: priorEntries, failures: ['could not list current attribute assignments — left unchanged'] }
  }

  const priorById = new Map(priorEntries.map((p) => [p.id, p]))
  const desiredIds = new Set(desired.map((d) => d.id))
  const entries: RefMemberEntry[] = []
  const failures: string[] = []

  for (const { id, meta } of desired) {
    if (live.ids.has(id)) {
      entries.push({ id, existed: priorById.get(id)?.existed ?? true })
      continue
    }
    const resp = await client.post(`${BASE}/${flowId}/userAttributeAssignments`, {
      isOptional: false,
      requiresVerification: false,
      userInputType: defaultUserInputType(meta.dataType),
      displayName: meta.displayName,
      userAttributeValues: [],
      userAttribute: { id },
    })
    if (!resp.ok) {
      failures.push(`add attribute ${id}: ${graphErrorMessage(resp)}`)
      continue
    }
    entries.push({ id, existed: false })
  }

  for (const p of priorEntries) {
    if (p.existed || desiredIds.has(p.id) || !live.ids.has(p.id)) continue
    const resp = await client.delete(`${BASE}/${flowId}/userAttributeAssignments/${p.id}`)
    if (!resp.ok && resp.status !== 404) {
      failures.push(`remove attribute ${p.id}: ${graphErrorMessage(resp)}`)
    }
  }

  return { entries, failures }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractB2xUserFlowSpecs(ctx.canvas).filter((s) => s.id)

  const listed = await client.getAll<LiveB2xUserFlow>(`${BASE}?$select=id,userFlowType,userFlowTypeVersion`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list b2x user flows: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveById = new Map<string, LiveB2xUserFlow>()
  for (const fl of listed.items) {
    if (fl.id) liveById.set(fl.id.toLowerCase(), fl)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorById = new Map(prior.filter((e) => e.id).map((e) => [e.id!.toLowerCase(), e]))

  // identityProviders/attributes resolve against the live tenant — a
  // picker-selected id passes straight through; a hand-typed id or display
  // name also resolves (both id spaces are opaque strings, not GUIDs, so this
  // uses id-set-or-name resolution rather than the isGuid-gated passthrough —
  // see lib/nameMaps.ts's header).
  const identityProviderMap = await buildIdNameMap(client, '/identity/identityProviders?$select=id,displayName')
  const attributeMaps = await buildAttributeMaps(client)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const expectedId = resultingId(spec.id)
    const live = liveById.get(expectedId.toLowerCase()) ?? null
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorById.get(expectedId.toLowerCase())

    let flowId: string | undefined
    let entry: RollbackEntry

    if (live?.id) {
      // Flows have no update operation — an existing flow is left as-is.
      flowId = live.id
      entry = { itemId: spec.itemId, name: live.id, existed: true, id: live.id }
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.id}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveB2xUserFlow>(resp.body)
      flowId = created?.id ?? expectedId
      entry = { itemId: spec.itemId, name: created?.id ?? expectedId, existed: false, id: created?.id ?? expectedId }
    }

    if (flowId) {
      const idpResolution = resolveByIdOrNameMany(spec.identityProviders, identityProviderMap)
      if (idpResolution.missing.length) {
        failures.push(
          `${spec.id}: unknown identity provider(s) ${idpResolution.missing.join(', ')} — create/verify them first or fix the id`
        )
        // Leave identity providers exactly as last tracked — don't touch Graph until every one resolves.
        entry.identityProviders = priorEntry?.identityProviders ?? []
      } else {
        const { members, failures: idpFailures } = await reconcileRefCollection(
          client,
          `${BASE}/${flowId}`,
          'identityProviders',
          idpResolution.ids,
          priorEntry?.identityProviders ?? [],
          'identityProviders'
        )
        entry.identityProviders = members
        for (const f of idpFailures) failures.push(`${spec.id}: ${f}`)
      }

      const attrResolution = resolveByIdOrNameMany(spec.attributes, attributeMaps)
      if (attrResolution.missing.length) {
        failures.push(
          `${spec.id}: unknown attribute(s) ${attrResolution.missing.join(', ')} — create/verify them first or fix the id`
        )
        // Leave attribute assignments exactly as last tracked — don't touch Graph until every one resolves.
        entry.attributes = priorEntry?.attributes ?? []
      } else {
        const desired = attrResolution.ids.map((id) => ({
          id,
          meta: attributeMaps.metaById.get(id) ?? { displayName: id },
        }))
        const { entries: attrEntries, failures: attrFailures } = await reconcileAttributeAssignments(
          client,
          flowId,
          desired,
          priorEntry?.attributes ?? []
        )
        entry.attributes = attrEntries
        for (const f of attrFailures) failures.push(`${spec.id}: ${f}`)
      }
    }

    entries.push(entry)
  }

  // Reconcile: delete flows THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => resultingId(s.id).toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id?.toLowerCase()).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id.toLowerCase()) && !declared.has(p.id.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some b2x user flows failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} b2x user flow(s)`,
    rollbackData: { entries },
  }
}
