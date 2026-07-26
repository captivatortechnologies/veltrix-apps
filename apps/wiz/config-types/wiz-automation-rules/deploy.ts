import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import {
  extractAutomationRuleSpecs,
  isJsonObject,
  ruleKey,
  tryParseJson,
  type AutomationRuleSpec,
  type FullAutomationRule,
  type LiveAutomationRule,
} from './validate'

// --- GraphQL operations (verified against the Wiz schema) --------------------

/** List automation rules (Relay connection). */
export const LIST_AUTOMATION_RULES_QUERY = `
query ListAutomationRules($first: Int, $after: String) {
  automationRules(first: $first, after: $after) {
    nodes {
      id
      name
      enabled
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/**
 * Read a single automation rule's scalar managed state (for update + restore).
 * `actionTemplateParams` is a GraphQL union and is deliberately NOT selected —
 * action bodies cannot be read back generically, so they are not managed state.
 */
export const GET_AUTOMATION_RULE_QUERY = `
query GetAutomationRule($id: ID!) {
  automationRule(id: $id) {
    id
    name
    description
    triggerSource
    triggerType
    filters
    enabled
  }
}`

const CREATE_AUTOMATION_RULE_MUTATION = `
mutation CreateAutomationRule($input: CreateAutomationRuleInput!) {
  createAutomationRule(input: $input) {
    automationRule { id }
  }
}`

const UPDATE_AUTOMATION_RULE_MUTATION = `
mutation UpdateAutomationRule($input: UpdateAutomationRuleInput!) {
  updateAutomationRule(input: $input) {
    automationRule { id }
  }
}`

const PAGE_SIZE = 100

/** The `AutomationRuleActionInput` we submit for a rule. */
export interface AutomationRuleActionInput {
  integrationId: string
  actionTemplateType: string
  actionTemplateParams?: Record<string, unknown>
}

export interface AutomationRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullAutomationRule
  /** The action(s) applied by this deploy — replayed on restore of a modified rule. */
  actions?: AutomationRuleActionInput[]
}

interface MutateRuleResult {
  createAutomationRule?: { automationRule?: { id?: string } }
  updateAutomationRule?: { automationRule?: { id?: string } }
}

interface GetRuleResult {
  automationRule?: FullAutomationRule
}

/**
 * Deploy Wiz automation rules via the GraphQL API.
 *
 * Identity is the rule `name`: list the tenant's automation rules, match on the
 * name, then update it (capturing its prior scalar state for rollback) or create
 * a new one. Each rule delivers to one integration via an action template.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractAutomationRuleSpecs(ctx.canvas).filter((s) => s.name && s.integrationId && s.actionTemplateType)
  const rollbackState: AutomationRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAutomationRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = ruleKey(spec.name)
      const live = byName.get(key)
      const actions = buildActions(spec)

      if (live && live.id) {
        const prior = await readRule(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior, actions })
        const res = await client.graphql<MutateRuleResult>(UPDATE_AUTOMATION_RULE_MUTATION, {
          input: { id: live.id, patch: buildRulePatch(spec, actions) },
        })
        assertMutationOk(res.transportError, res.errors, `update automation rule "${label}"`)
      } else {
        const res = await client.graphql<MutateRuleResult>(CREATE_AUTOMATION_RULE_MUTATION, {
          input: buildRuleInput(spec, actions),
        })
        assertMutationOk(res.transportError, res.errors, `create automation rule "${label}"`)
        const id = res.data?.createAutomationRule?.automationRule?.id
        if (!id) throw new Error(`Automation rule "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id, actions })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz automation rule(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Automation rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all automation rules; throws on error. */
export async function listAutomationRules(client: WizClient): Promise<LiveAutomationRule[]> {
  const res = await client.listConnection<LiveAutomationRule>(
    LIST_AUTOMATION_RULES_QUERY,
    'automationRules',
    PAGE_SIZE,
  )
  if (res.error) throw new Error(`Failed to list Wiz automation rules: ${res.error}`)
  return res.nodes
}

/** Read one rule's scalar managed state; throws on error. */
export async function readRule(client: WizClient, id: string): Promise<FullAutomationRule> {
  const res = await client.graphql<GetRuleResult>(GET_AUTOMATION_RULE_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read automation rule ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read automation rule ${id}: ${graphqlErrorMessage(res.errors)}`)
  const rule = res.data?.automationRule
  if (!rule) throw new Error(`Automation rule ${id} was not found`)
  return rule
}

/** Build the single-action array for a spec. */
export function buildActions(spec: AutomationRuleSpec): AutomationRuleActionInput[] {
  const action: AutomationRuleActionInput = {
    integrationId: spec.integrationId,
    actionTemplateType: spec.actionTemplateType,
  }
  const parsed = tryParseJson(spec.actionTemplateParams)
  if (parsed.ok && isJsonObject(parsed.value)) action.actionTemplateParams = parsed.value
  return [action]
}

/** Parse the optional filters blob into an object, or undefined when absent. */
function filtersFor(spec: AutomationRuleSpec): Record<string, unknown> | undefined {
  const parsed = tryParseJson(spec.filters)
  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined
}

/** The `CreateAutomationRuleInput` for a spec. */
export function buildRuleInput(spec: AutomationRuleSpec, actions: AutomationRuleActionInput[]): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    triggerSource: spec.triggerSource,
    triggerType: spec.triggerTypes,
    enabled: spec.enabled,
    actions,
  }
  const filters = filtersFor(spec)
  if (filters) input.filters = filters
  if (spec.projectId) input.projectId = spec.projectId
  return input
}

/** The `UpdateAutomationRulePatch` for a spec (projectId is create-time only). */
export function buildRulePatch(spec: AutomationRuleSpec, actions: AutomationRuleActionInput[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    triggerSource: spec.triggerSource,
    triggerType: spec.triggerTypes,
    enabled: spec.enabled,
    actions,
  }
  const filters = filtersFor(spec)
  if (filters) patch.filters = filters
  return patch
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
