import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractAgentExclusionSpecs, type AgentExclusionSpec, type LiveAgentExclusion } from './validate'

export interface AgentExclusionRollbackEntry {
  name: string
  /** Cloud scanner id the exclusion lives under — needed to build the path. */
  scannerId: string
  existed: boolean
  /** Numeric id (or uuid) returned by the API — the rollback key. */
  id?: number | string
  /** Prior state captured before an update, replayed on rollback. */
  prior?: Pick<LiveAgentExclusion, 'name' | 'members' | 'description' | 'schedule'>
}

/** Path base for a cloud scanner's agent exclusions collection. */
function agentExclusionsPath(scannerId: string): string {
  return `/scanners/${scannerId}/agent-exclusions`
}

/**
 * Deploy agent scan exclusions to a Tenable VM tenant via the Agent Exclusions
 * API. Agent exclusions live under a cloud scanner, so every call is scoped to
 * the item's scannerId: /scanners/{scannerId}/agent-exclusions.
 *
 * For each declared agent exclusion:
 *   - GET  /scanners/{scannerId}/agent-exclusions        — list + find by name
 *   - PUT  /scanners/{scannerId}/agent-exclusions/{id}   — update (keyed on id)
 *   - POST /scanners/{scannerId}/agent-exclusions        — create (capture id)
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

  const specs = extractAgentExclusionSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AgentExclusionRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findAgentExclusion(client, spec.scannerId, spec.name)

      if (existing && existing.id !== undefined) {
        rollbackState.push({
          name: spec.name,
          scannerId: spec.scannerId,
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

        const res = await client.request('PUT', `${agentExclusionsPath(spec.scannerId)}/${existing.id}`, {
          body: buildAgentExclusionBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update agent exclusion "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', agentExclusionsPath(spec.scannerId), {
          body: buildAgentExclusionBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create agent exclusion "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveAgentExclusion>(res.body)
        const createdId = created?.id
        rollbackState.push({ name: spec.name, scannerId: spec.scannerId, existed: false, id: createdId })
        if (createdId === undefined) {
          throw new Error(`Agent exclusion "${spec.name}" was created but the API returned no id`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} agent exclusion(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedAgentExclusions: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `Agent exclusion deployment failed after ${deployed.length} of ${specs.length} exclusion(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAgentExclusions: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/**
 * Look up an agent exclusion by exact name in the scanner's list; null when
 * absent. Scoped to the cloud scanner the exclusion lives under.
 */
export async function findAgentExclusion(
  client: TenableClient,
  scannerId: string,
  name: string,
): Promise<LiveAgentExclusion | null> {
  const res = await client.request('GET', agentExclusionsPath(scannerId))
  if (!res.ok) {
    throw new Error(`Failed to list agent exclusions while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const exclusions = parseJson<{ exclusions?: LiveAgentExclusion[] }>(res.body)?.exclusions ?? []
  // Names are not guaranteed unique — match the first exact name. Rollback is
  // keyed on the returned id, so an ambiguous name still reverts precisely.
  return exclusions.find((e) => e.name === name) ?? null
}

/**
 * Assemble the schedule object per the Agent Exclusions API rules:
 *   - disabled ("Always On") collapses to just { enabled: false }
 *   - enabled sends the window + an rrules OBJECT, attaching byweekday only for
 *     WEEKLY and bymonthday only for MONTHLY (where each is meaningful)
 */
export function buildSchedule(spec: AgentExclusionSpec): Record<string, unknown> {
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

/** Build the create/update request body for an agent exclusion. */
export function buildAgentExclusionBody(spec: AgentExclusionSpec): Record<string, unknown> {
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
