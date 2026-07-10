import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import { extractIocSpecs, type IocSpec, type LiveIndicator } from './validate'

/** Indicator fields this app manages and can restore on rollback. */
export interface IocRollbackEntry {
  type: string
  value: string
  existed: boolean
  id?: string
  prior?: Partial<
    Pick<
      LiveIndicator,
      | 'action'
      | 'severity'
      | 'platforms'
      | 'applied_globally'
      | 'host_groups'
      | 'expiration'
      | 'description'
      | 'tags'
    >
  >
}

const DEPLOY_COMMENT = 'Managed by Veltrix (crowdstrike-edr app)'

/**
 * Deploy custom IOCs to a Falcon tenant via the IOC Management API.
 *
 * For each declared indicator:
 *   - GET   /iocs/queries/indicators/v1?filter=type:'…'+value:'…'  — find it
 *   - GET   /iocs/entities/indicators/v1?ids=…  — capture prior state for rollback
 *   - PATCH /iocs/entities/indicators/v1        — update existing
 *   - POST  /iocs/entities/indicators/v1        — create missing
 *
 * An indicator's type/value pair is its identity — those never change here;
 * only the managed fields (action, severity, platforms, targeting,
 * expiration, description, tags) are written.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractIocSpecs(ctx.canvas).filter((s) => s.type && s.value)
  const rollbackState: IocRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findIndicator(client, spec.type, spec.value)

      if (existing) {
        rollbackState.push({
          type: spec.type,
          value: spec.value,
          existed: true,
          id: existing.id,
          prior: {
            action: existing.action,
            severity: existing.severity,
            platforms: existing.platforms,
            applied_globally: existing.applied_globally,
            host_groups: existing.host_groups,
            expiration: existing.expiration,
            description: existing.description,
            tags: existing.tags,
          },
        })

        const res = await client.request('PATCH', '/iocs/entities/indicators/v1', {
          body: {
            comment: DEPLOY_COMMENT,
            indicators: [{ id: existing.id, ...buildManagedFields(spec) }],
          },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update indicator "${spec.value}" (${spec.type}): ${patchFailure}`)
        }
      } else {
        const res = await client.request('POST', '/iocs/entities/indicators/v1', {
          body: {
            comment: DEPLOY_COMMENT,
            indicators: [{ type: spec.type, value: spec.value, ...buildManagedFields(spec) }],
          },
        })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to create indicator "${spec.value}" (${spec.type}): ${createFailure}`)
        }
        const created = parseEnvelope<LiveIndicator>(res.body)?.resources?.[0]
        rollbackState.push({ type: spec.type, value: spec.value, existed: false, id: created?.id })
        if (!created?.id) {
          throw new Error(
            `Indicator "${spec.value}" (${spec.type}) was created but the API returned no indicator id`,
          )
        }
      }

      deployed.push(spec.value)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} custom IOC(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedIndicators: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom IOC deployment failed after ${deployed.length} of ${specs.length} indicator(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedIndicators: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** FQL identity filter shared by deploy, healthCheck, and driftDetect. */
export function iocIdentityFilter(type: string, value: string): string {
  return `type:'${fqlEscape(type)}'+value:'${fqlEscape(value)}'`
}

/** Look up an indicator by its type/value identity; null when absent. */
export async function findIndicator(
  client: FalconClient,
  type: string,
  value: string,
): Promise<LiveIndicator | null> {
  const queryRes = await client.request('GET', '/iocs/queries/indicators/v1', {
    query: { filter: iocIdentityFilter(type, value), limit: 1 },
  })
  if (!queryRes.ok) {
    throw new Error(`Failed to search indicator "${value}" (${type}): ${falconErrorMessage(queryRes)}`)
  }

  const id = parseEnvelope<string>(queryRes.body)?.resources?.[0]
  if (!id) return null

  const detailRes = await client.request('GET', '/iocs/entities/indicators/v1', {
    query: { ids: id },
  })
  if (!detailRes.ok) {
    throw new Error(`Failed to read indicator "${value}" (${type}): ${falconErrorMessage(detailRes)}`)
  }
  return parseEnvelope<LiveIndicator>(detailRes.body)?.resources?.[0] ?? null
}

/** The mutable fields this app manages, as the API expects them. */
export function buildManagedFields(spec: IocSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    action: spec.action,
    severity: spec.severity,
    platforms: spec.platforms,
    applied_globally: spec.appliedGlobally,
  }
  if (!spec.appliedGlobally) fields.host_groups = spec.hostGroups
  if (spec.expiration) fields.expiration = spec.expiration
  if (spec.description) fields.description = spec.description
  if (spec.tags.length > 0) fields.tags = spec.tags
  return fields
}
