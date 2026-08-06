import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { updateCompanyDetails, type GzUpdateCompanyBody } from '../../lib/gravityZoneApi'
import type { CompanyProfileRollbackEntry } from './deploy'

/**
 * Roll back company profile declarations using the state captured during
 * deploy: only entries this deploy actually CHANGED are restored (via
 * companies.updateCompanyDetails with the prior values for exactly the
 * fields that were touched); untouched declarations are left alone.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: CompanyProfileRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.changed && entry.prior) {
        const body: GzUpdateCompanyBody = { ...entry.prior, companyId: entry.companyId || undefined }
        await updateCompanyDetails(client, body)
        reverted.push(entry.companyId || '(own company)')
      }
    }
    return {
      success: true,
      message: reverted.length
        ? `Rolled back ${reverted.length} company profile declaration(s): ${reverted.join(', ')}`
        : 'No company profile declarations required rollback (none were changed by this deploy).',
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.filter((p) => p.changed).length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
