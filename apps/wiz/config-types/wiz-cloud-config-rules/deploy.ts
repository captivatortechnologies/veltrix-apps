import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import {
  extractCloudConfigRuleSpecs,
  ruleKey,
  NO_IAC_MATCHER,
  type CloudConfigRuleSpec,
  type FullCloudConfigRule,
  type LiveCloudConfigRule,
} from './validate'

// --- GraphQL operations (verified against the Wiz schema) --------------------

/** List cloud configuration rules (Relay connection). Wiz caps the page size at 500. */
export const LIST_CLOUD_CONFIG_RULES_QUERY = `
query ListCloudConfigurationRules($first: Int, $after: String) {
  cloudConfigurationRules(first: $first, after: $after) {
    nodes {
      id
      name
      builtin
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** Read a single cloud configuration rule's full managed state (for update + restore). */
export const GET_CLOUD_CONFIG_RULE_QUERY = `
query GetCloudConfigurationRule($id: ID!) {
  cloudConfigurationRule(id: $id) {
    id
    name
    description
    targetNativeTypes
    opaPolicy
    severity
    enabled
    remediationInstructions
    functionAsControl
    builtin
    scopeAccounts { id }
    securitySubCategories { id }
    iacMatchers { type regoCode }
  }
}`

const CREATE_CLOUD_CONFIG_RULE_MUTATION = `
mutation CreateCloudConfigurationRule($input: CreateCloudConfigurationRuleInput!) {
  createCloudConfigurationRule(input: $input) {
    rule { id }
  }
}`

const UPDATE_CLOUD_CONFIG_RULE_MUTATION = `
mutation UpdateCloudConfigurationRule($input: UpdateCloudConfigurationRuleInput!) {
  updateCloudConfigurationRule(input: $input) {
    rule { id }
  }
}`

const PAGE_SIZE = 500

export interface CloudConfigRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullCloudConfigRule
}

interface MutateRuleResult {
  createCloudConfigurationRule?: { rule?: { id?: string } }
  updateCloudConfigurationRule?: { rule?: { id?: string } }
}

interface GetRuleResult {
  cloudConfigurationRule?: FullCloudConfigRule
}

/**
 * Deploy Wiz custom cloud configuration rules via the GraphQL API.
 *
 * Identity is the rule `name`: list the tenant's cloud configuration rules,
 * match a NON-builtin rule on the name, then update it (capturing its prior
 * state for rollback) or create a new one. Built-in rules are never matched or
 * modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractCloudConfigRuleSpecs(ctx.canvas).filter((s) => s.name && s.opaPolicy)
  const rollbackState: CloudConfigRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listCustomCloudConfigRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = ruleKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const prior = await readRule(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })
        const res = await client.graphql<MutateRuleResult>(UPDATE_CLOUD_CONFIG_RULE_MUTATION, {
          input: { id: live.id, patch: buildRulePatch(spec) },
        })
        assertMutationOk(res.transportError, res.errors, `update rule "${label}"`)
      } else {
        const res = await client.graphql<MutateRuleResult>(CREATE_CLOUD_CONFIG_RULE_MUTATION, {
          input: buildRuleInput(spec),
        })
        assertMutationOk(res.transportError, res.errors, `create rule "${label}"`)
        const id = res.data?.createCloudConfigurationRule?.rule?.id
        if (!id) throw new Error(`Rule "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz cloud configuration rule(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Cloud configuration rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all NON-builtin (custom) cloud configuration rules; throws on error. */
export async function listCustomCloudConfigRules(client: WizClient): Promise<LiveCloudConfigRule[]> {
  const res = await client.listConnection<LiveCloudConfigRule>(
    LIST_CLOUD_CONFIG_RULES_QUERY,
    'cloudConfigurationRules',
    PAGE_SIZE,
  )
  if (res.error) throw new Error(`Failed to list Wiz cloud configuration rules: ${res.error}`)
  return res.nodes.filter((r) => r.builtin !== true)
}

/** Read one rule's full managed state; throws on error. */
export async function readRule(client: WizClient, id: string): Promise<FullCloudConfigRule> {
  const res = await client.graphql<GetRuleResult>(GET_CLOUD_CONFIG_RULE_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read rule ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read rule ${id}: ${graphqlErrorMessage(res.errors)}`)
  const rule = res.data?.cloudConfigurationRule
  if (!rule) throw new Error(`Rule ${id} was not found`)
  return rule
}

/** Build the IaC matcher list for a spec (empty when no matcher is configured). */
function iacMatchersFor(spec: CloudConfigRuleSpec): Array<{ type: string; regoCode: string }> {
  if (spec.iacMatcherType === NO_IAC_MATCHER || !spec.iacRegoCode) return []
  return [{ type: spec.iacMatcherType, regoCode: spec.iacRegoCode }]
}

/** The `CreateCloudConfigurationRuleInput` for a spec. */
export function buildRuleInput(spec: CloudConfigRuleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    targetNativeTypes: spec.targetNativeTypes,
    opaPolicy: spec.opaPolicy,
    severity: spec.severity,
    enabled: spec.enabled,
    remediationInstructions: spec.remediationInstructions,
    functionAsControl: spec.functionAsControl,
    scopeAccountIds: spec.scopeAccountIds,
    securitySubCategories: spec.securitySubCategories,
    iacMatchers: iacMatchersFor(spec),
  }
}

/** The `UpdateCloudConfigurationRulePatch` for a spec (same managed fields as create). */
export function buildRulePatch(spec: CloudConfigRuleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    targetNativeTypes: spec.targetNativeTypes,
    opaPolicy: spec.opaPolicy,
    severity: spec.severity,
    enabled: spec.enabled,
    remediationInstructions: spec.remediationInstructions,
    functionAsControl: spec.functionAsControl,
    scopeAccountIds: spec.scopeAccountIds,
    securitySubCategories: spec.securitySubCategories,
    iacMatchers: iacMatchersFor(spec),
  }
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
