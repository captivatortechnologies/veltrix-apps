import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigClient, type SysdigMacro } from '../../lib/sysdigApi'
import { buildMacroBody, findMacroByName, normalizeEnabled } from './_shared'

/**
 * Deploy Sysdig Secure custom Falco macros over the REST API:
 *   find:    GET    /api/secure/falco/macros/groups?name=<name>
 *   create:  POST   /api/secure/falco/macros
 *   update:  PUT    /api/secure/falco/macros/<id>   (carries the live id + version)
 *   remove:  DELETE /api/secure/falco/macros/<id>   (for a disabled macro)
 *
 * The macro name is the stable identity used to upsert. `enabled: false` is
 * modeled as "absent from the custom rule library": a disabled macro that exists
 * is deleted (mirroring the Falco-rules config type). rollbackData records, per
 * macro, the action taken and the prior body so rollback can restore/remove.
 */
type MacroAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: MacroAction
  macroId: number | null
  /** The macro body BEFORE this deploy (null when it did not exist). */
  prior: SysdigMacro | null
}

/** Look up a macro by name (best-effort — a lookup error is treated as "not found"). */
async function findLive(client: SysdigClient, name: string): Promise<SysdigMacro | null> {
  try {
    return findMacroByName(await client.listFalcoMacrosByName(name), name)
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
        if (existing && existingId != null) {
          await client.deleteFalcoMacro(existingId)
          previous.push({ name, action: 'deleted', macroId: existingId, prior: existing })
        } else {
          previous.push({ name, action: 'noop', macroId: null, prior: null })
        }
        applied.push(`${name} (removed)`)
        continue
      }

      const body = buildMacroBody(item.fields)
      if (existing && existingId != null) {
        await client.updateFalcoMacro(existingId, { ...body, id: existingId, version: existing.version })
        previous.push({ name, action: 'updated', macroId: existingId, prior: existing })
      } else {
        const created = await client.createFalcoMacro(body)
        const newId = typeof created?.id === 'number' ? created.id : null
        previous.push({ name, action: 'created', macroId: newId, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Falco macro(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Falco macro deploy failed after ${applied.length} macro(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
