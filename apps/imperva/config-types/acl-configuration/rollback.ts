import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  ACL_CONFIGURE_PATH,
  isAclApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'
import { aclRestoreParams, type AclKind, type AclValues } from './_shared'

/**
 * Undo an ACL configuration deploy from rollbackData.previous (written by
 * deploy()): re-apply each ACL's prior value set with POST /sites/configure/acl.
 * The prior set is applied in full (an empty prior clears the list) so the site's
 * ACL is restored to exactly what it was before the deploy.
 */

interface PriorEntry {
  siteId: string
  aclId: string
  kind: AclKind
  prior: AclValues
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  try {
    for (const entry of previous) {
      const params = aclRestoreParams(entry.kind, entry.prior)
      const res = await client.post(ACL_CONFIGURE_PATH, { site_id: entry.siteId, rule_id: entry.aclId, ...params })
      const json = parseJson<ImpervaEnvelope>(res.body)
      if (!res.ok || !isAclApiSuccess(json)) {
        throw new Error(`restore ${entry.aclId} (site ${entry.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
      }
      restored++
    }
    return { success: true, message: `Rolled back ACLs: ${restored} restored.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
