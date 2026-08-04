import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type FirewallSchedule } from '../../lib/pfsenseApi'
import { extractSpecs, scheduleKey, snapshotSchedule, toScheduleBody } from './_shared'

export interface RollbackEntry {
  name: string
  id: number | string | null
  prior: Omit<FirewallSchedule, 'id'> | null
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data!.previous : []
  } catch {
    return []
  }
}

/**
 * Deploy firewall schedules over the pfSense REST API package:
 *   list:    GET  /api/v2/firewall/schedules
 *   create:  POST /api/v2/firewall/schedule (embeds one `timerange` entry)
 *   update:  PATCH /api/v2/firewall/schedule
 *   delete (a schedule this app created but no longer declares):
 *            DELETE /api/v2/firewall/schedule
 *   apply (once, after every write above): POST /api/v2/firewall/apply
 *     — FirewallSchedule is `always_apply: true` server-side, but this app
 *     still calls the shared endpoint once per deploy for consistency with
 *     every other config type here (harmless — verified idempotent).
 *
 * IDENTITY: `name` (unique) — same upsert/cleanup posture as
 * firewall-aliases' name-keyed pattern (only removes schedules this app
 * created). See _shared.ts's module doc on the rename caveat.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  const specs = extractSpecs(items).filter((s) => s.name && s.hour)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listFirewallSchedules()
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [scheduleKey(s.name), s]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(scheduleKey(spec.name)) ?? null
      const body = toScheduleBody(spec)

      if (match && match.id !== undefined) {
        await client.updateFirewallSchedule(match.id, body)
        previous.push({ name: spec.name, id: match.id, prior: snapshotSchedule(match) })
        updated++
      } else {
        const createdSchedule = await client.createFirewallSchedule(body)
        previous.push({ name: spec.name, id: createdSchedule.id ?? null, prior: null })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => scheduleKey(s.name)))
    for (const p of prior) {
      if (p.prior !== null || declaredNames.has(scheduleKey(p.name)) || p.id === null) continue
      await client.deleteFirewallSchedule(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense firewall schedule(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  }
}
