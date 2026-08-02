import type { CanvasSnapshot, DeployContext, DeployResult, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type FirewallRule } from '../../lib/pfsenseApi'
import { extractSpecs, snapshotRule, toRuleCreateBody, toRuleUpdateBody } from './_shared'

/**
 * One tracked rule, keyed by the CANVAS ITEM's stable id (see _shared.ts's
 * module doc on identity) — `id` is the live pfSense array-index id this
 * item currently maps to; `prior` is its managed body before the LAST write
 * (null when this app created it and has never captured a prior state).
 */
export interface RollbackEntry {
  itemId: string
  id: number | string
  prior: Omit<FirewallRule, 'id' | 'floating'> | null
}

/** Shared by deploy/rollback/driftDetect/healthCheck — the last successfully-deployed itemId->pfsenseId map. */
export async function loadPriorEntries(platform: PlatformDataApi, canvas: CanvasSnapshot): Promise<RollbackEntry[]> {
  try {
    const prev = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data!.previous : []
  } catch {
    return []
  }
}

/**
 * Deploy firewall rules over the pfSense REST API package:
 *   list (identity + full detail in one call): GET  /api/v2/firewall/rules
 *   create:                                    POST /api/v2/firewall/rule
 *   update (never sends `floating` — immutable): PATCH /api/v2/firewall/rule
 *   delete (a rule for a canvas item no longer
 *     declared):                                DELETE /api/v2/firewall/rule
 *   apply (once, after every write above):      POST /api/v2/firewall/apply
 *
 * IDENTITY: unlike firewall-aliases (matched by name), a pfSense rule has no
 * unique field to match on (verified — see _shared.ts's module doc), so this
 * config type tracks each canvas item's live pfSense id across deploys via
 * rollbackData. Because that tracking is itemId-keyed (not content-keyed), a
 * tracked entry only ever exists because THIS app created it — so removing a
 * declared item ALWAYS deletes the rule it produced (a different, simpler
 * cleanup rule than firewall-aliases' "only delete what we created" check,
 * which exists there specifically because name-based matching COULD collide
 * with a pre-existing, Veltrix-unrelated object).
 *
 * ORDERING: `spec.position`, when set, is passed straight through as the
 * REST API package's generic `placement` field on create/update — see
 * lib/pfsenseApi.ts's module doc for the full citation and the deliberate
 * choice NOT to auto-derive placement from canvas order.
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

  const specs = extractSpecs(items).filter((s) => s.itemId && s.type && s.ipprotocol)
  const newEntries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listFirewallRules()
    const liveById = new Map(live.filter((r) => r.id !== undefined).map((r) => [String(r.id), r]))
    const prior = await loadPriorEntries(ctx.platform, canvas)
    const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

    for (const spec of specs) {
      const priorEntry = priorByItemId.get(spec.itemId)
      const liveMatch = priorEntry ? liveById.get(String(priorEntry.id)) : undefined
      const placement = spec.position !== null ? { placement: spec.position } : undefined

      if (priorEntry && liveMatch) {
        await client.updateFirewallRule(priorEntry.id, toRuleUpdateBody(spec), placement)
        newEntries.push({ itemId: spec.itemId, id: priorEntry.id, prior: snapshotRule(liveMatch) })
        updated++
      } else {
        const createdRule = await client.createFirewallRule(toRuleCreateBody(spec), placement)
        newEntries.push({ itemId: spec.itemId, id: createdRule.id!, prior: null })
        created++
      }
    }

    const declaredItemIds = new Set(specs.map((s) => s.itemId))
    for (const p of prior) {
      if (declaredItemIds.has(p.itemId)) continue
      await client.deleteFirewallRule(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense firewall rule(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous: newEntries },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous: newEntries },
    }
  }
}
