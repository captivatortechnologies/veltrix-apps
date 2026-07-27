import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractRadiusServerSpecs, type RadiusServerSpec, type LiveRadiusServer } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped RADIUS server object path. */
export function radiusServerUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/user/radius`
}

export function buildRadiusServerBody(spec: RadiusServerSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, server: spec.server, 'auth-type': spec.authType }
  // Write-only secrets: always re-sent from canvas, never read back or diffed.
  if (spec.secret) body.secret = spec.secret
  if (spec.secondaryServer) body['secondary-server'] = spec.secondaryServer
  if (spec.secondarySecret) body['secondary-secret'] = spec.secondarySecret
  if (spec.nasIp) body['nas-ip'] = spec.nasIp
  if (spec.radiusPort) body['radius-port'] = Number(spec.radiusPort)
  if (spec.timeout) body.timeout = Number(spec.timeout)
  return body
}

export function snapshotLive(live: LiveRadiusServer): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['server', 'secondary-server', 'auth-type', 'nas-ip', 'radius-port', 'timeout'] as const) {
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
  const url = radiusServerUrl(settings.adom)
  const specs = extractRadiusServerSpecs(ctx.canvas).filter((s) => s.name)
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
      const live = Array.isArray(listed.data) ? (listed.data as LiveRadiusServer[]) : []
      const liveByName = new Map<string, LiveRadiusServer>()
      for (const s of live) if (s.name) liveByName.set(s.name.toLowerCase(), s)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildRadiusServerBody(spec))
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
    return { success: false, message: `Some RADIUS servers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} RADIUS server(s)`, rollbackData: { entries } }
}
