import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  addAlias,
  buildOpnsenseClient,
  deleteAlias,
  reconfigureAliases,
  searchAliases,
  setAlias,
  type LiveAlias,
} from '../../lib/opnsenseApi'
import { aliasKey, buildAliasBody, extractAliasSpecs, snapshotLive, type AliasSpec } from './_shared'
import type { RollbackEntry } from './rollback'

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy OPNsense firewall aliases via /api/firewall/alias.
 *
 * Identity is the alias `name`: list every configured alias (searchItem),
 * match on the name, and addItem (create) / setItem (update) each declared
 * alias. Aliases THIS app created in a prior successful deploy but no longer
 * declares are removed (delItem). Every one of those calls only STAGES the
 * change into the pending configuration — nothing reaches the running
 * firewall until reconfigure runs once, at the end, over every change this
 * deploy made together.
 *
 * Unlike a session-transactional API (e.g. Check Point's Management API),
 * OPNsense has no "discard" for a partially-staged batch: if a stage call
 * fails partway through, the aliases already staged BEFORE it stay staged in
 * the pending configuration, but reconfigure never runs — so nothing changes
 * on the wire. A failed deploy's rollbackData still records everything staged
 * so far, so rollback can cleanly undo it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: AliasSpec[] = extractAliasSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await searchAliases(client)
    const liveByName = new Map<string, LiveAlias>(live.filter((a) => a.name).map((a) => [aliasKey(a.name as string), a]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(aliasKey(spec.name)) ?? null
      const body = buildAliasBody(spec)

      if (match) {
        await setAlias(client, match.uuid, body)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const uuid = await addAlias(client, body)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, uuid })
        created++
      }
    }

    // Reconcile: remove aliases THIS app created previously but no longer declares.
    const declaredNames = new Set(specs.map((s) => aliasKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(aliasKey(p.name))) continue
      const stillLive = liveByName.get(aliasKey(p.name))
      if (!stillLive) continue // already gone (e.g. removed by hand) — nothing to delete
      await deleteAlias(client, stillLive.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    if (touched > 0) {
      await reconfigureAliases(client)
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} OPNsense alias(es) on ${host}: ${created} created, ${updated} updated, ` +
        `${deleted} removed${touched > 0 ? ' (applied via reconfigure)' : ' (nothing to apply)'}.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed (staged, not necessarily applied): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  }
}
