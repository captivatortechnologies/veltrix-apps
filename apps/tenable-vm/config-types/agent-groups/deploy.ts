import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractAgentGroupSpecs, type AgentGroupSpec, type LiveAgentGroup } from './validate'

export interface AgentGroupRollbackEntry {
  scannerId: string
  name: string
  existed: boolean
  /** Numeric id returned by the API — the rollback key (never the name). */
  id?: number
  /** Prior state captured before an update, replayed on rollback. */
  prior?: Pick<LiveAgentGroup, 'name'>
}

/**
 * Deploy agent groups to a Tenable tenant via the agent-groups API.
 *
 * Agent groups are scoped to a scanner, so every request is under
 * /scanners/{scannerId}. For each declared group:
 *   - GET  /scanners/{scannerId}/agent-groups        — list + find by name
 *   - PUT  /scanners/{scannerId}/agent-groups/{id}    — update existing (rename)
 *   - POST /scanners/{scannerId}/agent-groups         — create missing (capture id)
 *
 * The name is the group's only field AND its logical identity, so a matched
 * group is already in the desired state. We still issue the rename PUT
 * (idempotent — name → the same name) to keep the update path symmetric with
 * rollback, which restores the prior name. Create-vs-update is decided by the
 * first name match in the scanner's live list; rollback is keyed on the numeric
 * id the API returns — never on the name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAgentGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AgentGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.name} (scanner ${spec.scannerId})`

      const existing = await findAgentGroup(client, spec.scannerId, spec.name)

      if (existing && existing.id !== undefined) {
        rollbackState.push({
          scannerId: spec.scannerId,
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: { name: existing.name },
        })

        const res = await client.request(
          'PUT',
          `/scanners/${spec.scannerId}/agent-groups/${existing.id}`,
          { body: { name: spec.name } },
        )
        if (!res.ok) {
          throw new Error(`Failed to update agent group "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', `/scanners/${spec.scannerId}/agent-groups`, {
          body: { name: spec.name },
        })
        if (!res.ok) {
          throw new Error(`Failed to create agent group "${label}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveAgentGroup>(res.body)
        if (created?.id === undefined) {
          throw new Error(`Agent group "${label}" was created but the API returned no id`)
        }
        rollbackState.push({ scannerId: spec.scannerId, name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} agent group(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedAgentGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Agent group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAgentGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/**
 * Find an agent group by name within a scanner; null when absent.
 * GET /scanners/{scannerId}/agent-groups returns { groups: [...] }.
 */
export async function findAgentGroup(
  client: TenableClient,
  scannerId: string,
  name: string,
): Promise<LiveAgentGroup | null> {
  const res = await client.request('GET', `/scanners/${scannerId}/agent-groups`)
  if (!res.ok) {
    throw new Error(
      `Failed to list agent groups on scanner ${scannerId} while resolving "${name}": ${tenableErrorMessage(res)}`,
    )
  }
  const groups = parseJson<{ groups?: LiveAgentGroup[] }>(res.body)?.groups ?? []
  // The name is the logical identity within a scanner — match it exactly.
  return groups.find((g) => g.name === name) ?? null
}
