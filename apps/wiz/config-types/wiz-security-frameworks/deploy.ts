import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import {
  extractSecurityFrameworkSpecs,
  frameworkKey,
  type FullCategory,
  type FullSecurityFramework,
  type LiveSecurityFramework,
  type SecurityFrameworkSpec,
} from './validate'

// --- GraphQL operations (verified against the Wiz schema) --------------------

/** List security frameworks (Relay connection). */
export const LIST_SECURITY_FRAMEWORKS_QUERY = `
query ListSecurityFrameworks($first: Int, $after: String) {
  securityFrameworks(first: $first, after: $after) {
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

/** Read a single framework's full managed state (for update + restore). */
export const GET_SECURITY_FRAMEWORK_QUERY = `
query GetSecurityFramework($id: ID!) {
  securityFramework(id: $id) {
    id
    name
    description
    enabled
    builtin
    categories {
      id
      name
      description
      subCategories {
        id
        title
        description
        resolutionRecommendation
      }
    }
  }
}`

const CREATE_SECURITY_FRAMEWORK_MUTATION = `
mutation CreateSecurityFramework($input: CreateSecurityFrameworkInput!) {
  createSecurityFramework(input: $input) {
    framework { id }
  }
}`

const UPDATE_SECURITY_FRAMEWORK_MUTATION = `
mutation UpdateSecurityFramework($input: UpdateSecurityFrameworkInput!) {
  updateSecurityFramework(input: $input) {
    framework { id }
  }
}`

const PAGE_SIZE = 100

export interface SecurityFrameworkRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullSecurityFramework
}

interface MutateFrameworkResult {
  createSecurityFramework?: { framework?: { id?: string } }
  updateSecurityFramework?: { framework?: { id?: string } }
}

interface GetFrameworkResult {
  securityFramework?: FullSecurityFramework
}

/**
 * Deploy Wiz custom security frameworks via the GraphQL API.
 *
 * Identity is the framework `name`: list the tenant's security frameworks, match
 * a NON-builtin framework on the name, then update it (capturing its prior state
 * for rollback) or create a new one. Built-in Wiz frameworks are never matched or
 * modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractSecurityFrameworkSpecs(ctx.canvas).filter((s) => s.name && Array.isArray(s.categories))
  const rollbackState: SecurityFrameworkRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listCustomSecurityFrameworks(client)
    const byName = new Map(existing.filter((f) => f.name).map((f) => [frameworkKey(f.name as string), f]))

    for (const spec of specs) {
      const label = spec.name
      const key = frameworkKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const prior = await readFramework(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })
        const res = await client.graphql<MutateFrameworkResult>(UPDATE_SECURITY_FRAMEWORK_MUTATION, {
          input: { id: live.id, patch: buildFrameworkPatch(spec) },
        })
        assertMutationOk(res.transportError, res.errors, `update security framework "${label}"`)
      } else {
        const res = await client.graphql<MutateFrameworkResult>(CREATE_SECURITY_FRAMEWORK_MUTATION, {
          input: buildFrameworkInput(spec),
        })
        assertMutationOk(res.transportError, res.errors, `create security framework "${label}"`)
        const id = res.data?.createSecurityFramework?.framework?.id
        if (!id) throw new Error(`Security framework "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz security framework(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedFrameworks: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Security framework deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedFrameworks: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all NON-builtin (custom) security frameworks; throws on error. */
export async function listCustomSecurityFrameworks(client: WizClient): Promise<LiveSecurityFramework[]> {
  const res = await client.listConnection<LiveSecurityFramework>(
    LIST_SECURITY_FRAMEWORKS_QUERY,
    'securityFrameworks',
    PAGE_SIZE,
  )
  if (res.error) throw new Error(`Failed to list Wiz security frameworks: ${res.error}`)
  return res.nodes.filter((f) => f.builtin !== true)
}

/** Read one framework's full managed state; throws on error. */
export async function readFramework(client: WizClient, id: string): Promise<FullSecurityFramework> {
  const res = await client.graphql<GetFrameworkResult>(GET_SECURITY_FRAMEWORK_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read security framework ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read security framework ${id}: ${graphqlErrorMessage(res.errors)}`)
  const framework = res.data?.securityFramework
  if (!framework) throw new Error(`Security framework ${id} was not found`)
  return framework
}

const s = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Normalize the user's category JSON into `[SecurityCategoryInput]`. */
export function buildCategoriesInput(categories: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(categories)) return []
  return categories.map((raw) => {
    const cat = (raw ?? {}) as Record<string, unknown>
    const category: Record<string, unknown> = { name: s(cat.name) }
    if (s(cat.id)) category.id = s(cat.id)
    if (s(cat.description)) category.description = s(cat.description)
    if (s(cat.externalId)) category.externalId = s(cat.externalId)
    const subs = Array.isArray(cat.subCategories) ? cat.subCategories : []
    category.subCategories = subs.map((rawSub) => {
      const sub = (rawSub ?? {}) as Record<string, unknown>
      const subCategory: Record<string, unknown> = { title: s(sub.title), description: s(sub.description) }
      if (s(sub.id)) subCategory.id = s(sub.id)
      if (s(sub.externalId)) subCategory.externalId = s(sub.externalId)
      if (s(sub.resolutionRecommendation)) subCategory.resolutionRecommendation = s(sub.resolutionRecommendation)
      return subCategory
    })
    return category
  })
}

/** The `CreateSecurityFrameworkInput` for a spec. */
export function buildFrameworkInput(spec: SecurityFrameworkSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    categories: buildCategoriesInput(spec.categories),
  }
}

/** The `SecurityFrameworkPatch` for a spec (same managed fields as create). */
export function buildFrameworkPatch(spec: SecurityFrameworkSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    categories: buildCategoriesInput(spec.categories),
  }
}

/** Convert a prior read framework's categories into `[SecurityCategoryInput]`, preserving ids. */
export function priorCategoriesToInput(categories: FullCategory[] | undefined): Array<Record<string, unknown>> {
  return (categories ?? []).map((cat) => {
    const category: Record<string, unknown> = { name: cat.name ?? '' }
    if (cat.id) category.id = cat.id
    if (cat.description) category.description = cat.description
    category.subCategories = (cat.subCategories ?? []).map((sub) => {
      const subCategory: Record<string, unknown> = { title: sub.title ?? '', description: sub.description ?? '' }
      if (sub.id) subCategory.id = sub.id
      if (sub.resolutionRecommendation) subCategory.resolutionRecommendation = sub.resolutionRecommendation
      return subCategory
    })
    return category
  })
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
