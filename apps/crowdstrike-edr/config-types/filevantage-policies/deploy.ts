import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, type FalconClient } from '../../lib/falcon'
import {
  createFileVantage,
  findFileVantageByName,
  updateFileVantage,
  type FileVantageEndpoints,
} from '../../lib/filevantageAdapter'
import {
  extractPolicySpecs,
  fileVantageHostGroupIds,
  fileVantageRuleGroupIds,
  sameOrder,
} from './validate'

/** FileVantage Policy API surface — the shared entity/queries transport. */
export const FILEVANTAGE_POLICY_ENDPOINTS: FileVantageEndpoints = {
  entity: '/filevantage/entities/policies/v1',
  queries: '/filevantage/queries/policies/v1',
}

/** Host-group / rule-group assignment endpoints — separate PATCH calls, params in the query. */
export const POLICIES_HOST_GROUPS_PATH = '/filevantage/entities/policies-host-groups/v1'
export const POLICIES_RULE_GROUPS_PATH = '/filevantage/entities/policies-rule-groups/v1'

export type AssignmentAction = 'assign' | 'unassign' | 'precedence'

export interface FileVantagePolicyRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    /** Host groups this deployment attached — rollback detaches them. */
    hostGroupsAdded: string[]
    /** Host groups this deployment detached — rollback re-attaches them. */
    hostGroupsRemoved: string[]
    /** Rule groups this deployment attached — rollback detaches them. */
    ruleGroupsAdded: string[]
    /** Rule groups this deployment detached — rollback re-attaches them. */
    ruleGroupsRemoved: string[]
    /** Prior rule-group order — rollback restores it via the precedence action. */
    ruleGroupsPriorOrder: string[]
  }
}

/**
 * Deploy FileVantage (file integrity monitoring) policies to a Falcon tenant.
 *
 * For each declared policy:
 *   - find by name (FileVantage looks up by name alone) + capture prior state
 *   - PATCH existing (name, description, enabled) or POST create (name,
 *     platform, description) — new policies are created disabled
 *   - converge host group assignments to exactly the declared list
 *   - converge rule group assignments to exactly the declared list and set
 *     their precedence to the declared order
 *
 * Host-group and rule-group assignment are separate PATCH endpoints, not fields
 * on the policy body; platform is immutable via the API.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FileVantagePolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findFileVantageByName(client, FILEVANTAGE_POLICY_ENDPOINTS, spec.name)

      if (existing?.id) {
        const entry: FileVantagePolicyRollbackEntry = {
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empty so rollback can clear a description
            // this deployment sets on a policy that previously had none.
            description: existing.description ?? '',
            enabled: existing.enabled,
            hostGroupsAdded: [],
            hostGroupsRemoved: [],
            ruleGroupsAdded: [],
            ruleGroupsRemoved: [],
            ruleGroupsPriorOrder: fileVantageRuleGroupIds(existing),
          },
        }
        rollbackState.push(entry)

        // Converge assignments first, then flip enablement — a policy cannot be
        // enabled until it has the rule groups it monitors.
        await syncHostGroups(
          client,
          spec.name,
          existing.id,
          spec.hostGroups,
          fileVantageHostGroupIds(existing),
          entry.prior,
        )
        await syncRuleGroups(
          client,
          spec.name,
          existing.id,
          spec.ruleGroups,
          fileVantageRuleGroupIds(existing),
          entry.prior,
        )

        // name, description, and enabled converge in one PATCH — FileVantage
        // carries enablement on the policy body (no separate action call).
        await updateFileVantage(client, FILEVANTAGE_POLICY_ENDPOINTS, {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
          enabled: spec.enabled,
        })
      } else {
        const create: Record<string, unknown> = { name: spec.name, platform: spec.platform }
        if (spec.description !== undefined) create.description = spec.description

        const createdId = await createFileVantage(client, FILEVANTAGE_POLICY_ENDPOINTS, create)
        rollbackState.push({
          name: spec.name,
          platform: spec.platform,
          existed: false,
          id: createdId,
        })

        await syncHostGroups(client, spec.name, createdId, spec.hostGroups, [])
        await syncRuleGroups(client, spec.name, createdId, spec.ruleGroups, [])

        // New policies always start disabled — enable via a follow-up PATCH
        // once the rule groups it monitors are in place.
        if (spec.enabled) {
          await updateFileVantage(client, FILEVANTAGE_POLICY_ENDPOINTS, {
            id: createdId,
            name: spec.name,
            description: spec.description ?? '',
            enabled: true,
          })
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} FileVantage policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `FileVantage policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Build the `?policy_id=…&action=…&ids=A&ids=B` path (ids is collectionFormat multi). */
function assignmentPath(
  basePath: string,
  policyId: string,
  action: AssignmentAction,
  ids: string[],
): string {
  const parts = [
    `policy_id=${encodeURIComponent(policyId)}`,
    `action=${encodeURIComponent(action)}`,
    ...ids.map((id) => `ids=${encodeURIComponent(id)}`),
  ]
  return `${basePath}?${parts.join('&')}`
}

/** Assign / unassign / set precedence of host or rule groups on a policy. */
export async function policyGroupAction(
  client: FalconClient,
  basePath: string,
  policyId: string,
  action: AssignmentAction,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const res = await client.request('PATCH', assignmentPath(basePath, policyId, action, ids))
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`FileVantage "${action}" action failed: ${failure}`)
  }
}

/**
 * Converge a policy's host group assignments to exactly the declared list.
 * When `record` is given, every successful attach/detach is appended to it so
 * rollback reverses exactly the deltas this deployment applied.
 */
export async function syncHostGroups(
  client: FalconClient,
  policyName: string,
  policyId: string,
  desired: string[],
  current: string[],
  record?: { hostGroupsAdded: string[]; hostGroupsRemoved: string[] },
): Promise<void> {
  const desiredSet = new Set(desired)
  const currentSet = new Set(current)

  for (const groupId of desired) {
    if (!currentSet.has(groupId)) {
      try {
        await policyGroupAction(client, POLICIES_HOST_GROUPS_PATH, policyId, 'assign', [groupId])
        record?.hostGroupsAdded.push(groupId)
      } catch (error) {
        throw new Error(
          `Policy "${policyName}": failed to assign host group ${groupId} — ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        )
      }
    }
  }
  for (const groupId of current) {
    if (!desiredSet.has(groupId)) {
      try {
        await policyGroupAction(client, POLICIES_HOST_GROUPS_PATH, policyId, 'unassign', [groupId])
        record?.hostGroupsRemoved.push(groupId)
      } catch (error) {
        throw new Error(
          `Policy "${policyName}": failed to unassign host group ${groupId} — ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        )
      }
    }
  }
}

/**
 * Converge a policy's rule group assignments to exactly the declared list, then
 * set their precedence to the declared order so deploy and drift agree. When
 * `record` is given, every successful attach/detach is appended to it so
 * rollback reverses exactly the deltas this deployment applied.
 */
export async function syncRuleGroups(
  client: FalconClient,
  policyName: string,
  policyId: string,
  desired: string[],
  current: string[],
  record?: { ruleGroupsAdded: string[]; ruleGroupsRemoved: string[] },
): Promise<void> {
  const desiredSet = new Set(desired)
  const currentSet = new Set(current)

  for (const groupId of desired) {
    if (!currentSet.has(groupId)) {
      try {
        await policyGroupAction(client, POLICIES_RULE_GROUPS_PATH, policyId, 'assign', [groupId])
        record?.ruleGroupsAdded.push(groupId)
      } catch (error) {
        throw new Error(
          `Policy "${policyName}": failed to assign rule group ${groupId} — ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        )
      }
    }
  }
  for (const groupId of current) {
    if (!desiredSet.has(groupId)) {
      try {
        await policyGroupAction(client, POLICIES_RULE_GROUPS_PATH, policyId, 'unassign', [groupId])
        record?.ruleGroupsRemoved.push(groupId)
      } catch (error) {
        throw new Error(
          `Policy "${policyName}": failed to unassign rule group ${groupId} — ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        )
      }
    }
  }

  // Order is precedence — set it whenever two or more rule groups are declared
  // and the live order differs (membership change or reorder).
  if (desired.length >= 2 && !sameOrder(desired, current)) {
    try {
      await policyGroupAction(client, POLICIES_RULE_GROUPS_PATH, policyId, 'precedence', desired)
    } catch (error) {
      throw new Error(
        `Policy "${policyName}": failed to set rule group precedence — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
    }
  }
}
