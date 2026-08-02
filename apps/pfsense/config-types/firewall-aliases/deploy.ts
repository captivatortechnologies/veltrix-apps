import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type FirewallAlias } from '../../lib/pfsenseApi'
import { aliasKey, extractSpecs, snapshotAlias, toAliasBody } from './_shared'

export interface RollbackEntry {
  name: string
  id: number | string | null
  /** Prior managed body, captured before an update — null when THIS deploy created the alias. */
  prior: Omit<FirewallAlias, 'id' | 'name'> | null
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
 * Deploy firewall aliases over the pfSense REST API package:
 *   list (identity + full detail in one call): GET  /api/v2/firewall/aliases
 *   create:                                    POST /api/v2/firewall/alias
 *   update (never sends `name` — immutable):   PATCH /api/v2/firewall/alias
 *   delete (an alias this app created but no
 *     longer declares):                        DELETE /api/v2/firewall/alias
 *   apply (once, after every write above):      POST /api/v2/firewall/apply
 *
 * Unlike some ERS/session-based siblings, the REST API package's list
 * endpoint already returns each alias's FULL representation (not a summary),
 * so no per-item "get full detail" round trip is needed before diffing.
 *
 * The alias NAME is the stable identity used to upsert. rollbackData records,
 * per alias, its id AND the prior managed body (null when newly created) —
 * so rollback can restore the prior fields or delete the one this deploy
 * created. Pending changes are applied ONCE at the end (not per-item) to
 * avoid reloading the firewall filter once per alias.
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

  const specs = extractSpecs(items).filter((s) => s.name && s.type)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listAliases()
    const liveByName = new Map(live.filter((a) => a.name).map((a) => [aliasKey(a.name), a]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(aliasKey(spec.name)) ?? null
      const body = toAliasBody(spec)

      if (match && match.id !== undefined) {
        await client.updateAlias(match.id, { type: body.type, descr: body.descr, address: body.address, detail: body.detail })
        previous.push({ name: spec.name, id: match.id, prior: snapshotAlias(match) })
        updated++
      } else {
        const createdAlias = await client.createAlias(body)
        previous.push({ name: spec.name, id: createdAlias.id ?? null, prior: null })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => aliasKey(s.name)))
    for (const p of prior) {
      if (p.prior !== null || declaredNames.has(aliasKey(p.name)) || p.id === null) continue
      // This deploy previously created `p.name` (prior === null) and it is no
      // longer declared — remove it. An alias whose prior state was captured
      // (existed before Veltrix touched it) is left alone even if undeclared,
      // matching the sibling apps' "only clean up what we created" posture.
      await client.deleteAlias(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense firewall alias(es) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
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
