import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractOAuth2GrantSpecs, grantKey, type LiveOAuth2Grant } from './validate'
import { buildServicePrincipalNameToId, buildUserNameToId, resolveRef } from '../lib/nameMaps'

const BASE = '/oauth2PermissionGrants'

export interface RollbackEntry {
  itemId?: string
  /** The composite grant key, built from RESOLVED ids. */
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** A grant spec with clientId/resourceId/principalId already resolved from a
 *  picker-selected id or hand-typed display name to the actual object id. */
export interface ResolvedGrant {
  clientId: string
  resourceId: string
  consentType: string
  principalId: string
  scope: string
}

/** POST body — the full grant (scope is the only PATCH-updatable field). */
export function buildCreateBody(spec: ResolvedGrant): Record<string, unknown> {
  const body: Record<string, unknown> = {
    clientId: spec.clientId,
    consentType: spec.consentType,
    resourceId: spec.resourceId,
    scope: spec.scope,
  }
  if (spec.consentType === 'Principal' && spec.principalId) body.principalId = spec.principalId
  return body
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

  const specs = extractOAuth2GrantSpecs(ctx.canvas).filter((s) => s.clientId && s.resourceId)

  const listed = await client.getAll<LiveOAuth2Grant>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list oauth2 permission grants: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByKey = new Map<string, LiveOAuth2Grant>()
  for (const g of listed.items) {
    if (g.id) liveByKey.set(grantKey(g), g)
  }

  // clientId/resourceId are now live-picker fields storing a servicePrincipal
  // object id directly; principalId stores a user object id. A value that
  // already looks like a GUID passes straight through with no lookup; a
  // hand-typed display name/UPN (the pre-picker convention) resolves via
  // these live maps, built once for the whole deploy.
  const [spNameToId, userNameToId] = await Promise.all([
    buildServicePrincipalNameToId(client),
    buildUserNameToId(client),
  ])

  const prior = await loadPriorEntries(ctx)
  // Every grant THIS deploy declares (by itemId, so a resolution hiccup this
  // run never causes reconcile below to delete a still-declared grant).
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean) as string[])
  const declaredKeys = new Set<string>()
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const client_ = resolveRef(spec.clientId, spNameToId)
    const resource = resolveRef(spec.resourceId, spNameToId)
    const principal = spec.consentType === 'Principal' ? resolveRef(spec.principalId, userNameToId) : { id: '', missing: false }

    const missing = [
      ...(client_.missing ? [spec.clientId] : []),
      ...(resource.missing ? [spec.resourceId] : []),
      ...(principal.missing ? [spec.principalId] : []),
    ]
    if (missing.length) {
      failures.push(`unknown target(s) ${missing.join(', ')} — create/verify them first or fix the name`)
      continue
    }

    const resolved: ResolvedGrant = {
      clientId: client_.id,
      resourceId: resource.id,
      consentType: spec.consentType,
      principalId: principal.id,
      scope: spec.scope,
    }
    const key = grantKey(resolved)
    declaredKeys.add(key)
    const live = liveByKey.get(key) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, { scope: resolved.scope })
      if (!resp.ok) {
        failures.push(`${key}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: key, existed: true, id: live.id, prior: { scope: live.scope ?? '' } })
    } else {
      const resp = await client.post(BASE, buildCreateBody(resolved))
      if (!resp.ok) {
        failures.push(`${key}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveOAuth2Grant>(resp.body)
      entries.push({ itemId: spec.itemId, name: key, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete grants THIS app created previously but no longer
  // declares. A prior entry survives if either its itemId is still declared
  // (even if resolution failed this run) or its resolved key matches a
  // successfully-resolved spec this run.
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (p.existed || !p.id || keptIds.has(p.id)) continue
    if ((p.itemId && declaredItemIds.has(p.itemId)) || declaredKeys.has(p.name)) continue
    const resp = await client.delete(`${BASE}/${p.id}`)
    if (!resp.ok && resp.status !== 404) {
      failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some oauth2 permission grants failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} oauth2 permission grant(s)`,
    rollbackData: { entries },
  }
}
