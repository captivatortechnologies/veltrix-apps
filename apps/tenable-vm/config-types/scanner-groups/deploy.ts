import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import {
  extractScannerGroupSpecs,
  SCANNER_GROUP_TYPE,
  type LiveScannerGroup,
  type ScannerGroupSpec,
} from './validate'

export interface ScannerGroupRollbackEntry {
  name: string
  existed: boolean
  /** Numeric id returned by the API — the rollback key (never the name). */
  id?: number | string
  /** Prior state captured before an update, replayed on rollback. */
  prior?: Pick<LiveScannerGroup, 'name'>
}

/**
 * Deploy scanner groups to a Tenable VM tenant via the Scanner Groups API.
 *
 * For each declared group:
 *   - GET  /scanner-groups          — list + find by name (capture prior state)
 *   - PUT  /scanner-groups/{id}     — rename existing (keyed on the numeric id)
 *   - POST /scanner-groups          — create missing (capture the created id)
 *
 * A scanner group is a load-balancing pool; create sends { name, type } and the
 * type is always "load_balancing". The name is the only mutable managed field
 * (membership lives on separate endpoints and is not touched here). Names are
 * not guaranteed unique by the API, so create-vs-update is decided by the first
 * name match in the live list and rollback is keyed on the returned id.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractScannerGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ScannerGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findScannerGroup(client, spec.name)

      if (existing && existing.id !== undefined) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: { name: existing.name },
        })

        const res = await client.request('PUT', `/scanner-groups/${existing.id}`, {
          body: buildUpdatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update scanner group "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/scanner-groups', {
          body: buildCreatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create scanner group "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveScannerGroup>(res.body)
        const createdId = created?.id
        rollbackState.push({ name: spec.name, existed: false, id: createdId })
        if (createdId === undefined) {
          throw new Error(`Scanner group "${spec.name}" was created but the API returned no id`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} scanner group(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedScannerGroups: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scanner group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedScannerGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/** Look up a scanner group by exact name in the tenant list; null when absent. */
export async function findScannerGroup(
  client: TenableClient,
  name: string,
): Promise<LiveScannerGroup | null> {
  const res = await client.request('GET', '/scanner-groups')
  if (!res.ok) {
    throw new Error(`Failed to list scanner groups while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  // GET /scanner-groups returns the pools under `scanner_pools`.
  const groups = parseJson<{ scanner_pools?: LiveScannerGroup[] }>(res.body)?.scanner_pools ?? []
  // Names are not guaranteed unique — match the first exact name. Rollback is
  // keyed on the returned id, so an ambiguous name still reverts precisely.
  return groups.find((g) => g.name === name) ?? null
}

/** Build the create request body — a new group is a load-balancing pool. */
function buildCreatePayload(spec: ScannerGroupSpec): Record<string, unknown> {
  return { name: spec.name, type: SCANNER_GROUP_TYPE }
}

/** Build the update (rename) request body. Only the name is mutable here. */
function buildUpdatePayload(spec: ScannerGroupSpec): Record<string, unknown> {
  return { name: spec.name }
}
