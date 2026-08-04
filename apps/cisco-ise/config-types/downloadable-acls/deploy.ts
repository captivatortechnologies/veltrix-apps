import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type DownloadableAcl,
} from '../../lib/iseApi'
import { extractSpecs, toDownloadableAclBody } from './_shared'

/**
 * Deploy DACLs over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/downloadableacl?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/downloadableacl/{id}
 *   create:                      POST /ers/config/downloadableacl
 *   update:                      PUT  /ers/config/downloadableacl/{id}
 *
 * The DACL NAME is the stable identity used to upsert. rollbackData records,
 * per DACL, its id AND the prior full resource (null when it did not exist) —
 * so rollback can restore the prior content or delete the one we created.
 */
export interface RollbackEntry {
  name: string
  id: string | null
  acl: DownloadableAcl | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<DownloadableAcl>(base, 'downloadableacl', 'Downloadableacl', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name || !spec.dacl) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toDownloadableAclBody(spec))
        previous.push({ name: spec.name, id: existing.id, acl: prior })
      } else {
        const newId = await client.create(toDownloadableAclBody(spec))
        previous.push({ name: spec.name, id: newId, acl: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Downloadable ACL(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Downloadable ACL deploy failed after ${applied.length} ACL(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
