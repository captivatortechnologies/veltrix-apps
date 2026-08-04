import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, type Sgacl } from '../../lib/iseApi'
import { extractSpecs, toSgaclBody } from './_shared'

/**
 * Deploy SGACLs over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/sgacl?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/sgacl/{id}
 *   create:                      POST /ers/config/sgacl
 *   update:                      PUT  /ers/config/sgacl/{id}
 *
 * The SGACL NAME is the stable identity used to upsert. rollbackData records,
 * per SGACL, its id AND the prior full resource (null when it did not exist).
 */
export interface RollbackEntry {
  name: string
  id: string | null
  sgacl: Sgacl | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<Sgacl>(base, 'sgacl', 'Sgacl', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name || !spec.aclContent) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toSgaclBody(spec))
        previous.push({ name: spec.name, id: existing.id, sgacl: prior })
      } else {
        const newId = await client.create(toSgaclBody(spec))
        previous.push({ name: spec.name, id: newId, sgacl: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Security Group ACL(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `SGACL deploy failed after ${applied.length} ACL(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
