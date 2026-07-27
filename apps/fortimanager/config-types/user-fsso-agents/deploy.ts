import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractFssoAgentSpecs, type FssoAgentSpec, type LiveFssoAgent } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped FSSO agent object path. */
export function fssoAgentUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/user/fsso`
}

export function buildFssoAgentBody(spec: FssoAgentSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, server: spec.server, type: spec.type }
  if (spec.port) body.port = Number(spec.port)
  // Write-only secret: always re-sent from canvas, never read back or diffed.
  if (spec.password) body.password = spec.password
  if (spec.server2) body.server2 = spec.server2
  if (spec.server3) body.server3 = spec.server3
  if (spec.server4) body.server4 = spec.server4
  if (spec.ldapServer) body['ldap-server'] = spec.ldapServer
  return body
}

export function snapshotLive(live: LiveFssoAgent): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['server', 'port', 'server2', 'server3', 'server4', 'type', 'ldap-server'] as const) {
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
  const url = fssoAgentUrl(settings.adom)
  const specs = extractFssoAgentSpecs(ctx.canvas).filter((s) => s.name)
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
      const live = Array.isArray(listed.data) ? (listed.data as LiveFssoAgent[]) : []
      const liveByName = new Map<string, LiveFssoAgent>()
      for (const s of live) if (s.name) liveByName.set(s.name.toLowerCase(), s)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildFssoAgentBody(spec))
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
    return { success: false, message: `Some FSSO agents failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} FSSO agent(s)`, rollbackData: { entries } }
}
