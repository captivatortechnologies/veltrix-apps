import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getCompanyDetails, updateCompanyDetails, type GzUpdateCompanyBody } from '../../lib/gravityZoneApi'
import {
  buildCompanyUpdateBody,
  companyFieldsMatch,
  declaredLiveSnapshot,
  extractCompanyProfileSpecs,
  parseContactPerson,
  parseMdrContactInformation,
} from './_shared'

export interface CompanyProfileRollbackEntry {
  companyId: string
  changed: boolean
  prior?: GzUpdateCompanyBody
}

/**
 * Deploy GravityZone company profile declaration(s), reconciled by companyId
 * (blank = the company linked to the calling API key). A company always
 * exists — there is no create/delete, only companies.updateCompanyDetails —
 * and only fields the canvas declares NON-BLANK are sent; a blank field
 * means "leave this field alone", not "clear it".
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractCompanyProfileSpecs(ctx.canvas)
  const previous: CompanyProfileRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.companyId || '(own company)'
      const live = await getCompanyDetails(client, spec.companyId || undefined)
      const { value: contactPerson } = parseContactPerson(spec)
      const { value: mdrContactInformation } = parseMdrContactInformation(spec)

      if (companyFieldsMatch(spec, contactPerson, mdrContactInformation, live)) {
        previous.push({ companyId: spec.companyId, changed: false })
      } else {
        previous.push({ companyId: spec.companyId, changed: true, prior: declaredLiveSnapshot(spec, live) })
        const body = buildCompanyUpdateBody(spec, contactPerson, mdrContactInformation)
        await updateCompanyDetails(client, body)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} company profile declaration(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Company profile deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
