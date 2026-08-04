import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import {
  extractControlSpecs,
  controlKey,
  type ControlSpec,
  type FullControl,
  type LiveControl,
} from './validate'

// --- GraphQL operations --------------------------------------------------------
//
// createControl / updateControl / GetControl are VERIFIED verbatim against
// terraform-provider-wiz's resource_control.go (github.com/AxtonGrams/
// terraform-provider-wiz), the only reference implementation of this mutation.
//
// The `controls` list query below is NOT directly exercised by that reference
// provider (Terraform tracks a Control's identity via its own state file, so it
// only ever reads a Control by id) — it is inferred from the schema's
// `ControlFilters` input type and the now THRICE-verified plural-list /
// singular-by-id naming convention this app already relies on for
// `cloudConfigurationRule(s)` and `securityFramework(s)` (both live in
// production). If it does not resolve, deploy fails with a clear GraphQL error
// rather than silently misbehaving.

/** List controls (Relay connection). */
export const LIST_CONTROLS_QUERY = `
query ListControls($first: Int, $after: String) {
  controls(first: $first, after: $after) {
    nodes {
      id
      name
      severity
      enabled
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** Read a single control's full managed state (for update + restore). VERIFIED. */
export const GET_CONTROL_QUERY = `
query GetControl($id: ID!) {
  control(id: $id) {
    id
    name
    description
    query
    scopeQuery
    severity
    securitySubCategories {
      id
      title
    }
    enabled
    resolutionRecommendation
    scopeProject {
      id
      name
    }
  }
}`

/** VERIFIED against resource_control.go. Note: CreateControlInput has NO `enabled` field. */
const CREATE_CONTROL_MUTATION = `
mutation CreateControl($input: CreateControlInput!) {
  createControl(input: $input) {
    control { id }
  }
}`

/** VERIFIED against resource_control.go. */
const UPDATE_CONTROL_MUTATION = `
mutation UpdateControl($input: UpdateControlInput!) {
  updateControl(input: $input) {
    control { id }
  }
}`

const PAGE_SIZE = 100

export interface ControlRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullControl
}

interface MutateControlResult {
  createControl?: { control?: { id?: string } }
  updateControl?: { control?: { id?: string } }
}

interface GetControlResult {
  control?: FullControl
}

/**
 * Deploy Wiz controls via the GraphQL API.
 *
 * Identity is the control `name`: list the tenant's controls, match on the
 * name, then update it (capturing its prior state for rollback) or create a
 * new one. `enabled` is deliberately omitted from the create input — Wiz's
 * createControl mutation does not accept it (every control is created
 * enabled) — so a newly-created control that declares Enabled = false gets an
 * immediate follow-up updateControl call to correct it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractControlSpecs(ctx.canvas).filter((s) => s.name && s.query !== undefined && s.scopeQuery !== undefined)
  const rollbackState: ControlRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listControls(client)
    const byName = new Map(existing.filter((c) => c.name).map((c) => [controlKey(c.name as string), c]))

    for (const spec of specs) {
      const label = spec.name
      const key = controlKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const prior = await readControl(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })
        const res = await client.graphql<MutateControlResult>(UPDATE_CONTROL_MUTATION, {
          input: { id: live.id, patch: buildControlPatch(spec) },
        })
        assertMutationOk(res.transportError, res.errors, `update control "${label}"`)
      } else {
        const res = await client.graphql<MutateControlResult>(CREATE_CONTROL_MUTATION, {
          input: buildControlInput(spec),
        })
        assertMutationOk(res.transportError, res.errors, `create control "${label}"`)
        const id = res.data?.createControl?.control?.id
        if (!id) throw new Error(`Control "${label}" was created but Wiz returned no id`)

        // createControl ignores `enabled` (always creates enabled) — correct it now if declared false.
        if (!spec.enabled) {
          const fix = await client.graphql<MutateControlResult>(UPDATE_CONTROL_MUTATION, {
            input: { id, patch: { enabled: false } },
          })
          assertMutationOk(fix.transportError, fix.errors, `disable newly-created control "${label}"`)
        }

        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz control(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedControls: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Control deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedControls: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all controls; throws on error. */
export async function listControls(client: WizClient): Promise<LiveControl[]> {
  const res = await client.listConnection<LiveControl>(LIST_CONTROLS_QUERY, 'controls', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Wiz controls: ${res.error}`)
  return res.nodes
}

/** Read one control's full managed state; throws on error. */
export async function readControl(client: WizClient, id: string): Promise<FullControl> {
  const res = await client.graphql<GetControlResult>(GET_CONTROL_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read control ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read control ${id}: ${graphqlErrorMessage(res.errors)}`)
  const control = res.data?.control
  if (!control) throw new Error(`Control ${id} was not found`)
  return control
}

/** The `CreateControlInput` for a spec. No `enabled` field — see module docblock. */
export function buildControlInput(spec: ControlSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    resolutionRecommendation: spec.resolutionRecommendation,
    severity: spec.severity,
    projectId: spec.projectId,
    query: spec.query,
    scopeQuery: spec.scopeQuery,
    securitySubCategories: spec.securitySubCategories,
  }
}

/** The `UpdateControlPatch` for a spec. No `projectId` field — it is create-time only. */
export function buildControlPatch(spec: ControlSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    resolutionRecommendation: spec.resolutionRecommendation,
    severity: spec.severity,
    enabled: spec.enabled,
    query: spec.query,
    scopeQuery: spec.scopeQuery,
    securitySubCategories: spec.securitySubCategories,
  }
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
