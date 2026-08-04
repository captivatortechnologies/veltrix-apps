import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage, parseJson } from '../../lib/secretServerApi'
import {
  extractIpRestrictionSpecs,
  listIpRestrictions,
  findIpRestrictionByName,
  buildIpRestrictionCreateBody,
  buildIpRestrictionUpdateBody,
  restrictionIdOf,
  type LiveIpRestriction,
} from './_shared'

/**
 * One restriction's prior state, captured for rollback. `existed`
 * distinguishes an UPDATE (restore `prior`) from a CREATE (leave the new
 * restriction in place).
 */
export interface IpRestrictionRollbackEntry {
  name: string
  restrictionId: number | null
  existed: boolean
  prior: LiveIpRestriction | null
}

/**
 * Deploy Secret Server IP address restrictions over the REST API
 * (/api/v1/ipaddress-restrictions):
 *   read:   GET  /ipaddress-restrictions          → match by name (no server-side name filter; matched client-side)
 *   create: POST /ipaddress-restrictions            with { name, range }
 *   update: PUT  /ipaddress-restrictions/{id}       with { id, name, range }
 *
 * Identity is name. rollbackData records, per restriction, the prior body
 * (null when it did not exist) AND its id — so rollback can restore the prior
 * body, or leave a newly created restriction in place (deletion is not
 * managed by this app).
 *
 * NOTE: verified against the Delinea/Thycotic PowerShell module source;
 * verify request/response shapes against a live Secret Server 10.9.000064+.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const specs = extractIpRestrictionSpecs(items).filter((s) => s.name && s.range)

  const previous: IpRestrictionRollbackEntry[] = []
  const applied: string[] = []

  try {
    const allRestrictions = await listIpRestrictions(client)

    for (const spec of specs) {
      const existing = findIpRestrictionByName(allRestrictions, spec.name)

      if (existing) {
        const restrictionId = restrictionIdOf(existing)
        if (restrictionId === null) throw new Error(`IP address restriction "${spec.name}" exists but has no usable id`)
        const res = await client.request('PUT', `/ipaddress-restrictions/${restrictionId}`, { body: buildIpRestrictionUpdateBody(spec, existing) })
        if (!res.ok) throw new Error(`Failed to update IP address restriction "${spec.name}": ${secretServerErrorMessage(res)}`)
        previous.push({ name: spec.name, restrictionId, existed: true, prior: existing })
      } else {
        const res = await client.request('POST', '/ipaddress-restrictions', { body: buildIpRestrictionCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create IP address restriction "${spec.name}": ${secretServerErrorMessage(res)}`)
        const created = parseJson<LiveIpRestriction>(res.body)
        previous.push({
          name: spec.name,
          restrictionId: created ? restrictionIdOf(created) : null,
          existed: false,
          prior: null,
        })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} IP address restriction(s) to ${apiBase}: ${applied.join(', ') || '(none)'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `IP address restriction deploy failed after ${applied.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  }
}
