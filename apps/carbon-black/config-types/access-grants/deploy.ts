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
import { extractGrantSpecs, type GrantSpec, type LiveGrant, type LiveUser } from './validate'

// Grants are ADDITIVE ONLY: a declared role is added to whatever the principal
// already has, and removing an item from the canvas revokes only the roles
// this app itself granted — never a role change makes the principal lose
// access another admin (or another tool) granted directly. This mirrors the
// same additive-permission pattern this codebase uses for Datadog roles,
// avoiding a full-replace PUT that could silently strip out-of-band grants.

export interface RollbackEntry {
  itemId?: string
  principalEmail: string
  principalUrn: string
  /** whether a grant already existed for this principal before this app first touched it. */
  existed: boolean
  /** the role URNs this app declared/granted for this item (used to compute what to revoke on removal). */
  declaredRoles: string[]
  /** the grant's full roles snapshot BEFORE this deploy's merge — restored verbatim on rollback. */
  priorRoles: string[]
}

async function listUsers(client: CbClient, base: string): Promise<{ ok: boolean; items: LiveUser[]; err?: string }> {
  const res = await client.get(base)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ users?: LiveUser[] } | LiveUser[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.users ?? []
  return { ok: true, items }
}

async function getGrant(client: CbClient, base: string, principalUrn: string): Promise<{ found: boolean; ok: boolean; grant?: LiveGrant; err?: string }> {
  const res = await client.get(`${base}/${encodeURIComponent(principalUrn)}`)
  if (res.status === 404) return { found: false, ok: true }
  if (!res.ok) return { found: false, ok: false, err: cbErrorMessage(res) }
  return { found: true, ok: true, grant: parseJson<LiveGrant>(res.body) ?? undefined }
}

export function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
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
  const grantsBase = client.grantsPath()
  const orgRef = client.orgRefUrn()

  const specs = extractGrantSpecs(ctx.canvas).filter((s) => s.principalEmail && s.roles.length)

  const users = await listUsers(client, client.usersPath())
  if (!users.ok) return { success: false, message: `Failed to list Carbon Black users: ${users.err}` }
  const loginIdByEmail = new Map<string, string>()
  for (const u of users.items) {
    if (u.email && u.login_id !== undefined && u.login_id !== null) loginIdByEmail.set(u.email.toLowerCase(), String(u.login_id))
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map<string, RollbackEntry>()
  for (const p of prior) if (p.itemId) priorByItem.set(p.itemId, p)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const loginId = loginIdByEmail.get(spec.principalEmail)
    if (!loginId) {
      failures.push(`${spec.principalEmail}: no matching Carbon Black user found (this app does not create users — create the user first)`)
      continue
    }
    const principalUrn = `psc:user:${cred.orgKey}:${loginId}`

    const got = await getGrant(client, grantsBase, principalUrn)
    if (!got.ok) {
      failures.push(`${spec.principalEmail}: ${got.err}`)
      continue
    }
    if (got.found && got.grant?.profiles) {
      failures.push(`${spec.principalEmail}: existing grant uses multi-org profiles, which this config type does not manage — resolve manually`)
      continue
    }

    const priorRoles = got.found ? got.grant?.roles ?? [] : []
    const merged = union(priorRoles, spec.roles)
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined

    if (!got.found) {
      const created = await client.post(`${grantsBase}/`, {
        principal: principalUrn,
        principal_name: spec.principalEmail,
        org_ref: orgRef,
        roles: spec.roles,
      })
      if (!created.ok) {
        failures.push(`${spec.principalEmail}: ${cbErrorMessage(created)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, principalEmail: spec.principalEmail, principalUrn, existed: false, declaredRoles: spec.roles, priorRoles: [] })
      continue
    }

    const updated = await client.put(`${grantsBase}/${encodeURIComponent(principalUrn)}`, {
      principal: principalUrn,
      principal_name: got.grant?.principal_name ?? spec.principalEmail,
      org_ref: got.grant?.org_ref ?? orgRef,
      roles: merged,
    })
    if (!updated.ok) {
      failures.push(`${spec.principalEmail}: ${cbErrorMessage(updated)}`)
      continue
    }
    entries.push({
      itemId: spec.itemId,
      principalEmail: spec.principalEmail,
      principalUrn,
      existed: priorEntry ? priorEntry.existed : true,
      declaredRoles: spec.roles,
      priorRoles: priorEntry?.priorRoles ?? priorRoles,
    })
  }

  // Reconcile: for principals this app granted roles to previously but no
  // longer declares, revoke ONLY the roles this app added (read-modify-write);
  // delete the grant entirely only if this app created it from nothing AND no
  // roles remain.
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean) as string[])
  for (const p of prior) {
    if (p.itemId && declaredItems.has(p.itemId)) continue
    const got = await getGrant(client, grantsBase, p.principalUrn)
    if (!got.ok) {
      failures.push(`revoke ${p.principalEmail}: ${got.err}`)
      continue
    }
    if (!got.found) continue
    if (got.grant?.profiles) continue // never touch a profiles-based grant
    const liveRoles = got.grant?.roles ?? []
    const remaining = liveRoles.filter((r) => !p.declaredRoles.includes(r))
    if (remaining.length === liveRoles.length) continue // nothing this app granted is still present

    if (!p.existed && remaining.length === 0) {
      const del = await client.delete(`${grantsBase}/${encodeURIComponent(p.principalUrn)}`)
      if (!del.ok && del.status !== 404) failures.push(`revoke ${p.principalEmail}: ${cbErrorMessage(del)}`)
    } else {
      const put = await client.put(`${grantsBase}/${encodeURIComponent(p.principalUrn)}`, {
        principal: p.principalUrn,
        principal_name: got.grant?.principal_name ?? p.principalEmail,
        org_ref: got.grant?.org_ref ?? orgRef,
        roles: remaining,
      })
      if (!put.ok && put.status !== 404) failures.push(`revoke ${p.principalEmail}: ${cbErrorMessage(put)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some access grants failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} access grant(s)`, rollbackData: { entries } }
}
