import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractOAuth2GrantSpecs, grantKey, type OAuth2GrantSpec, type LiveOAuth2Grant } from './validate'

const BASE = '/oauth2PermissionGrants'

export interface RollbackEntry {
  itemId?: string
  /** The composite grant key. */
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** POST body — the full grant (scope is the only PATCH-updatable field). */
export function buildCreateBody(spec: OAuth2GrantSpec): Record<string, unknown> {
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

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = grantKey(spec)
    const live = liveByKey.get(key) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, { scope: spec.scope })
      if (!resp.ok) {
        failures.push(`${key}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: key, existed: true, id: live.id, prior: { scope: live.scope ?? '' } })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${key}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveOAuth2Grant>(resp.body)
      entries.push({ itemId: spec.itemId, name: key, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete grants THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => grantKey(s)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(p.name)) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
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
