import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, type Sgt } from '../../lib/iseApi'
import { extractSpecs, toSgtBody, AUTO_VALUE } from './_shared'

/**
 * Deploy SGTs over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/sgt?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/sgt/{id}
 *   create:                      POST /ers/config/sgt
 *   update:                      PUT  /ers/config/sgt/{id}
 *
 * The tag NAME is the stable identity used to upsert. `value: -1` means
 * "auto-assign" and is ONLY meaningful on create — on an UPDATE this app
 * preserves the tag's EXISTING numeric value rather than resending -1 (which
 * would otherwise ask ISE to reassign an already-live tag's number, an
 * unwanted side effect on every redeploy).
 */
export interface RollbackEntry {
  name: string
  id: string | null
  sgt: Sgt | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<Sgt>(base, 'sgt', 'Sgt', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        if (prior?.isReadOnly) {
          throw new Error(`Security Group Tag "${spec.name}" is built in/read-only and cannot be managed`)
        }
        const body = toSgtBody(spec)
        if (spec.value === AUTO_VALUE && prior?.value != null) body.value = prior.value
        await client.update(existing.id, body)
        previous.push({ name: spec.name, id: existing.id, sgt: prior })
      } else {
        const newId = await client.create(toSgtBody(spec))
        previous.push({ name: spec.name, id: newId, sgt: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Security Group Tag(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `SGT deploy failed after ${applied.length} tag(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
