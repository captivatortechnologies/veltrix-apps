import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployTable } from '../../lib/tableConfig'
import { trimStr } from '../../lib/tableRecords'
import { spec, isPasswordType } from './_shared'

interface PreviousEntry {
  identity: Record<string, string>
  sysId: string | null
  record: Record<string, unknown> | null
}

/**
 * Upsert system properties (sys_properties) by name over the Table API, then
 * SANITIZE the rollback snapshot for password/password2 properties.
 *
 * ServiceNow never returns a password-type property's real value on GET (it's
 * masked, e.g. "************"). The generic engine's rollback snapshot would
 * otherwise capture that masked placeholder as the "prior value" for an
 * updated property — and a later rollback would PATCH it back, permanently
 * overwriting the real secret with the mask. So: for every updated item whose
 * declared `type` is password/password2, this strips `value` out of its
 * snapshot. rollback.ts's PATCH is partial, so omitting the key leaves the
 * live value untouched instead of corrupting it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const result = await deployTable(ctx, spec)

  const data = result.rollbackData as { table: string; previous: PreviousEntry[] } | undefined
  if (data?.previous?.length) {
    const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
    const typeByName = new Map<string, string>()
    for (const item of items) typeByName.set(trimStr(item.fields.name), trimStr(item.fields.type))

    for (const entry of data.previous) {
      if (!entry.record) continue // a created record has nothing to restore
      if (isPasswordType(typeByName.get(entry.identity.name))) {
        delete entry.record.value
      }
    }
  }

  return result
}
