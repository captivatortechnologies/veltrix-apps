import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage, falconFailure, parseEnvelope, type FalconClient } from '../../lib/falcon'
import { currentGroupIds, findPolicyByName, policyAction, syncHostGroups } from '../../lib/policyAdapter'
import {
  FIREWALL_ENDPOINTS,
  PLATFORM_NAME_TO_ID,
  extractFirewallPolicySpecs,
  type FirewallPolicySpec,
  type LiveFirewallContainer,
  type LiveFirewallPolicy,
} from './validate'

/**
 * Deploy firewall policies to a Falcon tenant. A firewall policy is SPLIT across
 * two API collections and this handler wires them together:
 *
 *   1. Policy SHELL — the /policy/ family (via lib/policyAdapter):
 *        - GET   /policy/combined/firewall/v1   — find + capture prior shell state
 *        - POST  /policy/entities/firewall/v1   — create missing (starts disabled)
 *        - PATCH /policy/entities/firewall/v1   — update name/description
 *        - POST  /policy/entities/firewall-actions/v1?action_name=enable|disable|add-host-group|remove-host-group
 *      This owns name, description, platform_name, enablement, and host groups.
 *
 *   2. Policy CONTAINER — the fwmgr service (settings that are NOT on the shell):
 *        - GET  /fwmgr/entities/policies/v1?ids=<policyId>  — read platform_id + tracking
 *        - PUT  /fwmgr/entities/policies/v2                 — set rule_group_ids
 *          (ordered = precedence), default_inbound/outbound, enforce, test_mode,
 *          local_logging
 *      Every firewall policy auto-creates a container, so this is always a PUT
 *      (upsert) that echoes the container's platform_id and tracking token.
 *
 * Order of operations (verified against CrowdStrike's own Terraform provider):
 * create/patch shell → converge enablement → sync host groups → PUT container.
 *
 * NOTE: the fwmgr container write is PUT /fwmgr/entities/policies/v2. The v1
 * route is deprecated; the request body is identical between the two.
 */
export interface FirewallPolicyRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    /** Host groups this deployment attached — rollback detaches them. */
    groupsAdded: string[]
    /** Host groups this deployment detached — rollback re-attaches them. */
    groupsRemoved: string[]
    /** Prior fwmgr container settings — rollback PUTs these back wholesale. */
    container?: {
      platform_id?: string
      rule_group_ids?: string[]
      default_inbound?: string
      default_outbound?: string
      enforce?: boolean
      test_mode?: boolean
      local_logging?: boolean
    }
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractFirewallPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FirewallPolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findFirewallPolicy(client, spec.name, spec.platform)

      if (existing?.id) {
        // Capture prior shell + container state BEFORE mutating anything.
        const priorContainer = await getPolicyContainer(client, existing.id)
        const entry: FirewallPolicyRollbackEntry = {
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            description: existing.description ?? '',
            enabled: existing.enabled,
            groupsAdded: [],
            groupsRemoved: [],
            container: priorContainer
              ? {
                  platform_id: priorContainer.platform_id,
                  rule_group_ids: priorContainer.rule_group_ids ?? [],
                  default_inbound: priorContainer.default_inbound,
                  default_outbound: priorContainer.default_outbound,
                  enforce: priorContainer.enforce,
                  test_mode: priorContainer.test_mode,
                  local_logging: priorContainer.local_logging,
                }
              : undefined,
          },
        }
        rollbackState.push(entry)

        // 1. shell: name/description (platform_name is immutable)
        await patchShell(client, { id: existing.id, name: spec.name, description: spec.description ?? '' })

        // 2. enablement
        if (existing.enabled !== spec.enabled) {
          await policyAction(client, FIREWALL_ENDPOINTS, existing.id, spec.enabled ? 'enable' : 'disable')
        }

        // 3. host groups (records deltas so rollback reverses exactly this deploy)
        await syncHostGroups(
          client,
          FIREWALL_ENDPOINTS,
          spec.name,
          existing.id,
          spec.hostGroups,
          currentGroupIds(existing),
          entry.prior,
        )

        // 4. container: rule groups + defaults + enforce/test/logging
        const platformId = priorContainer?.platform_id ?? PLATFORM_NAME_TO_ID[spec.platform]
        await putPolicyContainer(client, spec, existing.id, platformId, priorContainer?.tracking)
      } else {
        // 1. shell
        const created = await createShell(client, spec)
        rollbackState.push({ name: spec.name, platform: spec.platform, existed: false, id: created })

        // 2. enablement (new policies always start disabled)
        if (spec.enabled) await policyAction(client, FIREWALL_ENDPOINTS, created, 'enable')

        // 3. host groups
        await syncHostGroups(client, FIREWALL_ENDPOINTS, spec.name, created, spec.hostGroups, [])

        // 4. container — read the auto-created one for platform_id + tracking, then PUT
        const container = await getPolicyContainer(client, created)
        const platformId = container?.platform_id ?? PLATFORM_NAME_TO_ID[spec.platform]
        await putPolicyContainer(client, spec, created, platformId, container?.tracking)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} firewall policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Firewall policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Shell (policy family) helpers -------------------------------------------

/** Look up a firewall policy shell by exact name + platform via the policy adapter. */
export async function findFirewallPolicy(
  client: FalconClient,
  name: string,
  platform: string,
): Promise<LiveFirewallPolicy | null> {
  return (await findPolicyByName(client, FIREWALL_ENDPOINTS, name, platform)) as LiveFirewallPolicy | null
}

/** Create the policy shell (name/description/platform_name). Returns the new id. */
async function createShell(client: FalconClient, spec: FirewallPolicySpec): Promise<string> {
  const resource: Record<string, unknown> = { name: spec.name, platform_name: spec.platform }
  if (spec.description !== undefined) resource.description = spec.description

  const res = await client.request('POST', FIREWALL_ENDPOINTS.entity, { body: { resources: [resource] } })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create policy "${spec.name}": ${failure}`)
  }
  const created = parseEnvelope<LiveFirewallPolicy>(res.body)?.resources?.[0]
  if (!created?.id) {
    throw new Error(`Policy "${spec.name}" was created but the API returned no policy id`)
  }
  return created.id
}

/** Patch the policy shell's name/description. */
async function patchShell(
  client: FalconClient,
  body: { id: string; name: string; description: string },
): Promise<void> {
  const res = await client.request('PATCH', FIREWALL_ENDPOINTS.entity, { body: { resources: [body] } })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update policy "${body.name}": ${failure}`)
  }
}

// --- Container (fwmgr) helpers -----------------------------------------------

/** Read a firewall policy's fwmgr container (platform_id, tracking, settings) by policy id. */
export async function getPolicyContainer(
  client: FalconClient,
  policyId: string,
): Promise<LiveFirewallContainer | null> {
  const res = await client.request('GET', '/fwmgr/entities/policies/v1', { query: { ids: policyId } })
  if (!res.ok) {
    throw new Error(`Failed to read firewall policy container ${policyId}: ${falconErrorMessage(res)}`)
  }
  return parseEnvelope<LiveFirewallContainer>(res.body)?.resources?.[0] ?? null
}

/** Upsert a firewall policy's fwmgr container settings (PUT v2). */
export async function putPolicyContainer(
  client: FalconClient,
  spec: FirewallPolicySpec,
  policyId: string,
  platformId: string | undefined,
  tracking: string | undefined,
): Promise<void> {
  const body: Record<string, unknown> = {
    policy_id: policyId,
    platform_id: platformId,
    rule_group_ids: spec.ruleGroups,
    default_inbound: spec.defaultInbound,
    default_outbound: spec.defaultOutbound,
    enforce: spec.enforce,
    test_mode: spec.testMode,
    local_logging: spec.localLogging,
  }
  if (tracking) body.tracking = tracking

  const res = await client.request('PUT', '/fwmgr/entities/policies/v2', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update firewall settings for policy "${spec.name}": ${failure}`)
  }
}

/** Restore a firewall policy's container to captured prior settings (used by rollback). */
export async function restorePolicyContainer(
  client: FalconClient,
  policyName: string,
  policyId: string,
  prior: NonNullable<FirewallPolicyRollbackEntry['prior']>['container'],
  tracking: string | undefined,
): Promise<void> {
  if (!prior) return
  const body: Record<string, unknown> = {
    policy_id: policyId,
    platform_id: prior.platform_id,
    rule_group_ids: prior.rule_group_ids ?? [],
    default_inbound: prior.default_inbound,
    default_outbound: prior.default_outbound,
    enforce: prior.enforce ?? false,
    test_mode: prior.test_mode ?? false,
    local_logging: prior.local_logging ?? false,
  }
  if (tracking) body.tracking = tracking

  const res = await client.request('PUT', '/fwmgr/entities/policies/v2', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to restore firewall settings for policy "${policyName}": ${failure}`)
  }
}
