import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type PcClient,
} from '../../lib/prismacloud'
import { extractUserSpecs, type LiveUser, type UserSpec } from './validate'

const V2 = '/v2/user'
/** Delete has NO v2 prefix — confirmed against the CSPM UserProfile API spec. */
const V1 = '/user'

export interface RollbackEntry {
  itemId?: string
  email: string
  /** Whether the user existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  prior?: {
    firstName: string
    lastName: string
    timeZone: string
    defaultRoleId: string
    /**
     * The full role-id set to restore. Prisma's read model never returns the
     * full multi-role assignment (only the single active roleId) — so this is
     * carried forward from what THIS APP last applied, not from a live read.
     */
    roleIds: string[]
    accessKeysAllowed: boolean
    enabled: boolean
  }
}

/** Body for POST/PUT /v2/user. `enabled` is read-only here — set separately via the status endpoint. */
export function userBody(spec: UserSpec): Record<string, unknown> {
  return {
    email: spec.email,
    firstName: spec.firstName,
    lastName: spec.lastName,
    timeZone: spec.timeZone,
    defaultRoleId: spec.defaultRoleId,
    roleIds: spec.roleIds,
    accessKeysAllowed: spec.accessKeysAllowed,
  }
}

async function setEnabled(client: PcClient, email: string, enabled: boolean): Promise<{ ok: boolean; err?: string }> {
  const res = await client.patch(`${V1}/${encodeURIComponent(email)}/status/${enabled}`)
  if (!res.ok) return { ok: false, err: pcErrorMessage(res) }
  return { ok: true }
}

async function listUsers(client: PcClient): Promise<{ ok: boolean; items: LiveUser[]; err?: string }> {
  const res = await client.get(V2)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveUser[]>(res.body) ?? [] }
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
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractUserSpecs(ctx.canvas).filter(
    (s) => s.email && s.firstName && s.lastName && s.timeZone && s.defaultRoleId && s.roleIds.length > 0
  )

  const listed = await listUsers(client)
  if (!listed.ok) return { success: false, message: `Failed to list users: ${listed.err}` }
  const liveByEmail = new Map<string, LiveUser>()
  for (const u of listed.items) {
    if (u.email) liveByEmail.set(u.email.toLowerCase(), u)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = spec.email.toLowerCase()
    const live = liveByEmail.get(key)
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined

    if (live) {
      const resp = await client.put(`${V2}/${encodeURIComponent(spec.email)}`, userBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.email}: ${pcErrorMessage(resp)}`)
        continue
      }
      const liveEnabled = live.enabled ?? true
      if (spec.enabled !== liveEnabled) {
        const st = await setEnabled(client, spec.email, spec.enabled)
        if (!st.ok) failures.push(`${spec.email}: failed to set enabled=${spec.enabled}: ${st.err}`)
      }
      entries.push({
        itemId: spec.itemId,
        email: spec.email,
        existed: true,
        prior: {
          firstName: live.firstName ?? '',
          lastName: live.lastName ?? '',
          timeZone: live.timeZone ?? '',
          defaultRoleId: live.roleId ?? '',
          // Full role-id set is never readable back — carry forward what we
          // last applied; fall back to the single live roleId as a floor.
          roleIds: priorEntry?.prior?.roleIds ?? (live.roleId ? [live.roleId] : []),
          accessKeysAllowed: live.accessKeysAllowed ?? false,
          enabled: liveEnabled,
        },
      })
    } else {
      const resp = await client.post(V2, userBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.email}: ${pcErrorMessage(resp)}`)
        continue
      }
      // New profiles are created enabled by default — only act if disabling.
      if (!spec.enabled) {
        const st = await setEnabled(client, spec.email, false)
        if (!st.ok) failures.push(`${spec.email}: failed to set enabled=false: ${st.err}`)
      }
      entries.push({ itemId: spec.itemId, email: spec.email, existed: false })
    }
  }

  // Reconcile: delete users THIS app created previously but no longer declares.
  const declaredEmails = new Set(specs.map((s) => s.email.toLowerCase()))
  const keptExisted = new Set(entries.filter((e) => e.existed).map((e) => e.email.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredEmails.has(p.email.toLowerCase()) && !keptExisted.has(p.email.toLowerCase())) {
      const resp = await client.delete(`${V1}/${encodeURIComponent(p.email)}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.email}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some users failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} user(s)`, rollbackData: { entries } }
}
