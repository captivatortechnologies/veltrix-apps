import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import {
  extractHostConfigRuleSpecs,
  ruleKey,
  type FullHostConfigRule,
  type HostConfigRuleSpec,
  type LiveHostConfigRule,
} from './validate'

// --- GraphQL operations --------------------------------------------------------
//
// The `hostConfigurationRules` list query is VERIFIED verbatim against
// terraform-provider-wiz's data_source_host_configuration_rules.go (github.com/
// AxtonGrams/terraform-provider-wiz) — its shipped `wiz_host_config_rules` data
// source. The singular `hostConfigurationRule(id)` read and the create/update/
// delete mutations are NOT directly exercised by any known running code (see
// the caveat in canvas.yaml) — they are built from the verified
// CreateHostConfigurationRuleInput / UpdateHostConfigurationRulePatch /
// DeleteHostConfigurationRuleInput Go types in that same package's internal/wiz
// (a schema-derived SDK), plus the now-repeated plural-list / singular-by-id
// naming convention this app already relies on elsewhere in this schema.

/** List host configuration rules (Relay connection). VERIFIED. */
export const LIST_HOST_CONFIG_RULES_QUERY = `
query ListHostConfigurationRules($first: Int, $after: String) {
  hostConfigurationRules(first: $first, after: $after) {
    nodes {
      id
      name
      enabled
      builtin
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** Read a single rule's full managed state (for update + restore). */
export const GET_HOST_CONFIG_RULE_QUERY = `
query GetHostConfigurationRule($id: ID!) {
  hostConfigurationRule(id: $id) {
    id
    name
    description
    directOVAL
    enabled
    builtin
    targetPlatforms {
      id
    }
    securitySubCategories {
      id
    }
  }
}`

const CREATE_HOST_CONFIG_RULE_MUTATION = `
mutation CreateHostConfigurationRule($input: CreateHostConfigurationRuleInput!) {
  createHostConfigurationRule(input: $input) {
    rule { id }
  }
}`

const UPDATE_HOST_CONFIG_RULE_MUTATION = `
mutation UpdateHostConfigurationRule($input: UpdateHostConfigurationRuleInput!) {
  updateHostConfigurationRule(input: $input) {
    rule { id }
  }
}`

const PAGE_SIZE = 100

export interface HostConfigRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullHostConfigRule
}

interface MutateRuleResult {
  createHostConfigurationRule?: { rule?: { id?: string } }
  updateHostConfigurationRule?: { rule?: { id?: string } }
}

interface GetRuleResult {
  hostConfigurationRule?: FullHostConfigRule
}

/**
 * Deploy Wiz host configuration rules via the GraphQL API.
 *
 * Identity is the rule `name`: list the tenant's host configuration rules,
 * match a NON-builtin rule on the name, then update it (capturing its prior
 * state for rollback) or create a new one. Built-in Wiz rules are never
 * matched or modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractHostConfigRuleSpecs(ctx.canvas).filter((s) => s.name && s.directOval && s.targetPlatformIds.length > 0)
  const rollbackState: HostConfigRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listCustomHostConfigRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = ruleKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const prior = await readRule(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })
        const res = await client.graphql<MutateRuleResult>(UPDATE_HOST_CONFIG_RULE_MUTATION, {
          input: { id: live.id, patch: buildRulePatch(spec) },
        })
        assertMutationOk(res.transportError, res.errors, `update host configuration rule "${label}"`)
      } else {
        const res = await client.graphql<MutateRuleResult>(CREATE_HOST_CONFIG_RULE_MUTATION, {
          input: buildRuleInput(spec),
        })
        assertMutationOk(res.transportError, res.errors, `create host configuration rule "${label}"`)
        const id = res.data?.createHostConfigurationRule?.rule?.id
        if (!id) throw new Error(`Host configuration rule "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz host configuration rule(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Host configuration rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all NON-builtin (custom) host configuration rules; throws on error. */
export async function listCustomHostConfigRules(client: WizClient): Promise<LiveHostConfigRule[]> {
  const res = await client.listConnection<LiveHostConfigRule>(
    LIST_HOST_CONFIG_RULES_QUERY,
    'hostConfigurationRules',
    PAGE_SIZE,
  )
  if (res.error) throw new Error(`Failed to list Wiz host configuration rules: ${res.error}`)
  return res.nodes.filter((r) => r.builtin !== true)
}

/** Read one rule's full managed state; throws on error. */
export async function readRule(client: WizClient, id: string): Promise<FullHostConfigRule> {
  const res = await client.graphql<GetRuleResult>(GET_HOST_CONFIG_RULE_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read host configuration rule ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read host configuration rule ${id}: ${graphqlErrorMessage(res.errors)}`)
  const rule = res.data?.hostConfigurationRule
  if (!rule) throw new Error(`Host configuration rule ${id} was not found`)
  return rule
}

/** The `CreateHostConfigurationRuleInput` for a spec. */
export function buildRuleInput(spec: HostConfigRuleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    directOVAL: spec.directOval,
    targetPlatformIds: spec.targetPlatformIds,
    enabled: spec.enabled,
    securitySubCategories: spec.securitySubCategories,
  }
}

/** The `UpdateHostConfigurationRulePatch` for a spec (same managed fields as create). */
export function buildRulePatch(spec: HostConfigRuleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    directOVAL: spec.directOval,
    targetPlatformIds: spec.targetPlatformIds,
    enabled: spec.enabled,
    securitySubCategories: spec.securitySubCategories,
  }
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
