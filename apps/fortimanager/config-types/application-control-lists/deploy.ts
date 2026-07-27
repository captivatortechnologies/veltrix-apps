import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractAppControlSpecs, parseJsonField, type AppControlSpec, type LiveAppControl } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped application control profile object path. */
export function appControlUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/application/list`
}

export function buildAppControlBody(spec: AppControlSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    'other-application-action': spec.otherApplicationAction,
    'unknown-application-action': spec.unknownApplicationAction,
    'app-replacemsg': spec.appReplacemsg,
    'deep-app-inspection': spec.deepAppInspection,
    'enforce-default-app-port': spec.enforceDefaultAppPort,
  }
  if (spec.comment) body.comment = spec.comment
  const parsed = parseJsonField(spec.entries)
  if (parsed.ok && Array.isArray(parsed.value)) body.entries = parsed.value
  return body
}

export function snapshotLive(live: LiveAppControl): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of [
    'comment',
    'other-application-action',
    'unknown-application-action',
    'app-replacemsg',
    'deep-app-inspection',
    'enforce-default-app-port',
    'entries',
  ] as const) {
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
  const url = appControlUrl(settings.adom)
  const specs = extractAppControlSpecs(ctx.canvas).filter((s) => s.name)
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
      const live = Array.isArray(listed.data) ? (listed.data as LiveAppControl[]) : []
      const liveByName = new Map<string, LiveAppControl>()
      for (const p of live) if (p.name) liveByName.set(p.name.toLowerCase(), p)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildAppControlBody(spec))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${fmgErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, name: spec.name, existed: !!liveMatch, prior: liveMatch ? snapshotLive(liveMatch) : undefined })
      }

      // Reconcile preserves unowned/built-in profiles: only delete profiles THIS
      // app created (existed:false) that are no longer declared.
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
    return { success: false, message: `Some application control profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} application control profile(s)`, rollbackData: { entries } }
}
