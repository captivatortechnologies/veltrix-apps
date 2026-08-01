import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigRule } from '../../lib/sysdigApi'
import { buildRuleBody, findRuleByName, normalizeEnabled } from './_shared'

/**
 * Deploy Sysdig Secure custom Falco rules over the REST API:
 *   find:    GET    /api/secure/rules/groups?name=<name>&type=FALCO
 *   create:  POST   /api/secure/rules
 *   update:  PUT    /api/secure/rules/<id>   (carries the live id + version)
 *   remove:  DELETE /api/secure/rules/<id>   (for a disabled rule)
 *
 * The rule name is the stable identity used to upsert. Sysdig has no per-rule
 * enabled toggle — rules are enabled through policies — so this app models
 * `enabled: false` as "absent from the custom rule library": a disabled rule
 * that exists is deleted. rollbackData records, per rule, the action taken and
 * the prior rule body so rollback can restore/remove precisely.
 */
type RuleAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: RuleAction
  ruleId: number | null
  /** The rule body BEFORE this deploy (null when it did not exist). */
  prior: SysdigRule | null
}

/** Look up a rule by name (best-effort — a lookup error is treated as "not found"). */
async function findLive(client: SysdigClient, name: string): Promise<SysdigRule | null> {
  try {
    return findRuleByName(await client.listRulesByName(name), name)
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const enabled = normalizeEnabled(item.fields.enabled)

      const existing = await findLive(client, name)
      const existingId = typeof existing?.id === 'number' ? existing.id : null

      if (!enabled) {
        // Disabled = absent from the custom library. Remove it if present.
        if (existing && existingId != null) {
          await client.deleteRule(existingId)
          previous.push({ name, action: 'deleted', ruleId: existingId, prior: existing })
        } else {
          previous.push({ name, action: 'noop', ruleId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildRuleBody(item.fields)
      if (existing && existingId != null) {
        // Carry the live id + version so the update targets the right revision.
        await client.updateRule(existingId, { ...body, id: existingId, version: existing.version })
        previous.push({ name, action: 'updated', ruleId: existingId, prior: existing })
      } else {
        const created = await client.createRule(body)
        const newId = typeof created?.id === 'number' ? created.id : null
        previous.push({ name, action: 'created', ruleId: newId, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Falco rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Falco rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
