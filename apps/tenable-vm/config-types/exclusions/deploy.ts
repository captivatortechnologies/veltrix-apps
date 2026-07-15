import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractExclusionSpecs, type ExclusionSpec, type LiveExclusion } from './validate'

export interface ExclusionRollbackEntry {
  name: string
  existed: boolean
  /** Numeric id (or uuid) returned by the API — the rollback key. */
  id?: number | string
  /** Prior state captured before an update, replayed on rollback. */
  prior?: Pick<LiveExclusion, 'name' | 'members' | 'description' | 'schedule'>
}

/**
 * Deploy scan exclusions to a Tenable VM tenant via the Exclusions API.
 *
 * For each declared exclusion:
 *   - GET  /exclusions               — list + find by name (capture prior state)
 *   - PUT  /exclusions/{id}          — update existing (keyed on the numeric id)
 *   - POST /exclusions               — create missing (capture the created id)
 *
 * Names are not guaranteed unique by the API, so create-vs-update is decided by
 * the first name match in the live list and rollback is keyed on the id the API
 * returns — never on the name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractExclusionSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ExclusionRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findExclusion(client, spec.name)

      if (existing && existing.id !== undefined) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture an explicit empty so rollback can clear a value the
            // deployment set on an exclusion that previously had none.
            members: existing.members ?? '',
            description: existing.description ?? '',
            schedule: existing.schedule ?? null,
          },
        })

        const res = await client.request('PUT', `/exclusions/${existing.id}`, {
          body: buildExclusionBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update exclusion "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/exclusions', { body: buildExclusionBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create exclusion "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveExclusion>(res.body)
        const createdId = created?.id
        rollbackState.push({ name: spec.name, existed: false, id: createdId })
        if (createdId === undefined) {
          throw new Error(`Exclusion "${spec.name}" was created but the API returned no id`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} exclusion(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `Exclusion deployment failed after ${deployed.length} of ${specs.length} exclusion(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/** Look up an exclusion by exact name in the tenant list; null when absent. */
export async function findExclusion(
  client: TenableClient,
  name: string,
): Promise<LiveExclusion | null> {
  const res = await client.request('GET', '/exclusions')
  if (!res.ok) {
    throw new Error(`Failed to list exclusions while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const exclusions = parseJson<{ exclusions?: LiveExclusion[] }>(res.body)?.exclusions ?? []
  // Names are not guaranteed unique — match the first exact name. Rollback is
  // keyed on the returned id, so an ambiguous name still reverts precisely.
  return exclusions.find((e) => e.name === name) ?? null
}

/**
 * Assemble the schedule object per the Exclusions API rules:
 *   - disabled ("Always On") collapses to just { enabled: false }
 *   - enabled sends the window + an rrules OBJECT, attaching byweekday only for
 *     WEEKLY and bymonthday only for MONTHLY (where each is meaningful)
 */
export function buildSchedule(spec: ExclusionSpec): Record<string, unknown> {
  if (!spec.enabled) {
    return { enabled: false }
  }

  const freq = spec.freq ?? 'ONETIME'
  const rrules: Record<string, unknown> = { freq, interval: spec.interval ?? 1 }
  if (freq === 'WEEKLY' && spec.byweekday) {
    rrules.byweekday = spec.byweekday
  }
  if (freq === 'MONTHLY' && spec.bymonthday !== undefined) {
    rrules.bymonthday = spec.bymonthday
  }

  return {
    enabled: true,
    starttime: spec.starttime,
    endtime: spec.endtime,
    timezone: spec.timezone ?? 'Etc/UTC',
    rrules,
  }
}

/** Build the create/update request body for an exclusion. */
export function buildExclusionBody(spec: ExclusionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    schedule: buildSchedule(spec),
  }
  // members is a COMMA-SEPARATED STRING (not an array). Always send it so
  // clearing it on the canvas converges the live exclusion.
  body.members = spec.members
  if (spec.description) body.description = spec.description
  return body
}
