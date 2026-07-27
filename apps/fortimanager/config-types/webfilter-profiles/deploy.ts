import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractWebFilterProfileSpecs, parseBodyJson, type WebFilterProfileSpec, type LiveWebFilterProfile } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped web filter profile object path. */
export function webfilterProfileUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/webfilter/profile`
}

function ed(b: boolean): 'enable' | 'disable' {
  return b ? 'enable' : 'disable'
}

export function buildWebFilterProfileBody(spec: WebFilterProfileSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    'https-replacemsg': ed(spec.httpsReplacemsg),
    'log-all-url': ed(spec.logAllUrl),
    'web-content-log': ed(spec.webContentLog),
    'extended-log': ed(spec.extendedLog),
    wisp: ed(spec.wisp),
  }
  if (spec.comment) body.comment = spec.comment
  // Spread the validated nested body (ftgd-wf, web, override …) over the scalars.
  Object.assign(body, parseBodyJson(spec.bodyJson).value)
  return body
}

export function snapshotLive(live: LiveWebFilterProfile): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['comment', 'https-replacemsg', 'log-all-url', 'web-content-log', 'extended-log', 'wisp'] as const) {
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
  const url = webfilterProfileUrl(settings.adom)
  const specs = extractWebFilterProfileSpecs(ctx.canvas).filter((s) => s.name)
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
      const live = Array.isArray(listed.data) ? (listed.data as LiveWebFilterProfile[]) : []
      const liveByName = new Map<string, LiveWebFilterProfile>()
      for (const p of live) if (p.name) liveByName.set(p.name.toLowerCase(), p)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildWebFilterProfileBody(spec))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${fmgErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, name: spec.name, existed: !!liveMatch, prior: liveMatch ? snapshotLive(liveMatch) : undefined })
      }

      // Reconcile: only delete profiles THIS app created (existed:false). Built-in
      // default profiles reject delete and are preserved by this scope.
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
    return { success: false, message: `Some web filter profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} web filter profile(s)`, rollbackData: { entries } }
}
