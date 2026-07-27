import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractLdapServerSpecs, type LdapServerSpec, type LiveLdapServer } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped LDAP server object path. */
export function ldapServerUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/user/ldap`
}

export function buildLdapServerBody(spec: LdapServerSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, server: spec.server, type: spec.type, secure: spec.secure }
  if (spec.secondaryServer) body['secondary-server'] = spec.secondaryServer
  if (spec.cnid) body.cnid = spec.cnid
  if (spec.dn) body.dn = spec.dn
  if (spec.type === 'regular' && spec.username) body.username = spec.username
  // Write-only secret: always re-sent from canvas, never read back or diffed.
  if (spec.password) body.password = spec.password
  if (spec.port) body.port = Number(spec.port)
  if (spec.groupMemberCheck) body['group-member-check'] = spec.groupMemberCheck
  if (spec.groupSearchBase) body['group-search-base'] = spec.groupSearchBase
  return body
}

export function snapshotLive(live: LiveLdapServer): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['server', 'secondary-server', 'cnid', 'dn', 'type', 'username', 'port', 'secure', 'group-member-check', 'group-search-base'] as const) {
    if (live[k] !== undefined) body[k] = live[k]
  }
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
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildFmgClient(cred, settings)
  const url = ldapServerUrl(settings.adom)
  const specs = extractLdapServerSpecs(ctx.canvas).filter((s) => s.name)
  const failures: string[] = []
  const entries: RollbackEntry[] = []

  if (settings.workspaceMode) {
    const lock = await client.lock(settings.adom)
    if (!lock.ok) {
      await client.logout()
      return { success: false, message: `Failed to lock ADOM "${settings.adom}": ${fmgErrorMessage(lock)}` }
    }
  }

  try {
    const listed = await client.get(url)
    if (!listed.ok) {
      failures.push(`list: ${fmgErrorMessage(listed)}`)
    } else {
      const live = Array.isArray(listed.data) ? (listed.data as LiveLdapServer[]) : []
      const liveByName = new Map<string, LiveLdapServer>()
      for (const s of live) if (s.name) liveByName.set(s.name.toLowerCase(), s)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildLdapServerBody(spec))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${fmgErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, name: spec.name, existed: !!liveMatch, prior: liveMatch ? snapshotLive(liveMatch) : undefined })
      }

      const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
      for (const p of prior) {
        if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
          const resp = await client.delete(url, ['name', '==', p.name])
          if (!resp.ok) failures.push(`delete ${p.name}: ${fmgErrorMessage(resp)}`)
        }
      }
    }

    if (settings.workspaceMode) await finishWorkspace(client, settings.adom, failures)
  } finally {
    await client.logout()
  }

  if (failures.length) {
    return { success: false, message: `Some LDAP servers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} LDAP server(s)`, rollbackData: { entries } }
}
