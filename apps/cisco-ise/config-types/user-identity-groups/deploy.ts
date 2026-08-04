import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, type IdentityGroup } from '../../lib/iseApi'
import { extractSpecs, toIdentityGroupBody } from './_shared'

/**
 * Deploy identity groups over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/identitygroup?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/identitygroup/{id}
 *   create:                      POST /ers/config/identitygroup
 *   update:                      PUT  /ers/config/identitygroup/{id}
 *
 * The group NAME is the stable identity used to upsert. A `parent` group NAME
 * is resolved to its id via a live lookup on this SAME resource — items are
 * applied in canvas order, so an earlier item in this configuration can be a
 * later item's parent (it is already live in ISE by the time its child is
 * processed). An unresolvable parent name fails that item's deploy with a
 * clear message rather than silently dropping the parent assignment.
 */
export interface RollbackEntry {
  name: string
  id: string | null
  group: IdentityGroup | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<IdentityGroup>(base, 'identitygroup', 'IdentityGroup', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name) continue

      let parentId: string | null = null
      if (spec.parentName) {
        const parent = await client.findByName(spec.parentName)
        if (!parent) {
          throw new Error(`Group "${spec.name}" references parent "${spec.parentName}", which does not exist in ISE`)
        }
        parentId = parent.id
      }

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toIdentityGroupBody(spec, parentId))
        previous.push({ name: spec.name, id: existing.id, group: prior })
      } else {
        const newId = await client.create(toIdentityGroupBody(spec, parentId))
        previous.push({ name: spec.name, id: newId, group: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} identity group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
