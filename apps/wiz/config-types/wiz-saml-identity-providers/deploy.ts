import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import { extractSamlIdpSpecs, idpKey, type FullSamlIdp, type LiveSamlIdp, type SamlIdpSpec } from './validate'

// --- GraphQL operations --------------------------------------------------------
//
// createSAMLIdentityProvider / updateSAMLIdentityProvider /
// deleteSAMLIdentityProvider / GetSamlIdp are VERIFIED verbatim against
// terraform-provider-wiz's resource_saml_idp.go (github.com/AxtonGrams/
// terraform-provider-wiz), the only reference implementation of this mutation.
//
// The `samlIdentityProviders` list query below is NOT directly exercised by
// that reference provider (Terraform tracks identity via its own state file, so
// it only ever reads a provider by id) — it is inferred from the now-repeated
// plural-list / singular-by-id naming convention this app already relies on
// elsewhere in this schema (cloudConfigurationRule(s), securityFramework(s),
// hostConfigurationRule(s)). If it does not resolve, deploy fails with a clear
// GraphQL error rather than silently misbehaving.

/** List SAML identity providers (Relay connection). */
export const LIST_SAML_IDPS_QUERY = `
query ListSamlIdentityProviders($first: Int, $after: String) {
  samlIdentityProviders(first: $first, after: $after) {
    nodes {
      id
      name
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** Read a single provider's full managed state (for update + restore). VERIFIED. */
export const GET_SAML_IDP_QUERY = `
query GetSamlIdentityProvider($id: ID!) {
  samlIdentityProvider(id: $id) {
    id
    name
    issuerURL
    loginURL
    logoutURL
    useProviderManagedRoles
    allowManualRoleOverride
    certificate
    domains
    mergeGroupsMappingByRole
    groupMapping {
      providerGroupId
      role {
        id
      }
      projects {
        id
      }
    }
  }
}`

/** VERIFIED against resource_saml_idp.go. */
const CREATE_SAML_IDP_MUTATION = `
mutation CreateSAMLIdentityProvider($input: CreateSAMLIdentityProviderInput!) {
  createSAMLIdentityProvider(input: $input) {
    samlIdentityProvider { id }
  }
}`

/** VERIFIED against resource_saml_idp.go. */
const UPDATE_SAML_IDP_MUTATION = `
mutation UpdateSAMLIdentityProvider($input: UpdateSAMLIdentityProviderInput!) {
  updateSAMLIdentityProvider(input: $input) {
    samlIdentityProvider { id }
  }
}`

const PAGE_SIZE = 100

export interface SamlIdpRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullSamlIdp
}

interface MutateIdpResult {
  createSAMLIdentityProvider?: { samlIdentityProvider?: { id?: string } }
  updateSAMLIdentityProvider?: { samlIdentityProvider?: { id?: string } }
}

interface GetIdpResult {
  samlIdentityProvider?: FullSamlIdp
}

/**
 * Deploy Wiz SAML identity providers via the GraphQL API.
 *
 * Identity is the provider `name`: list the tenant's providers, match on the
 * name, then update it (capturing its prior state for rollback) or create a
 * new one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractSamlIdpSpecs(ctx.canvas).filter((s) => s.name && s.loginUrl && s.certificate)
  const rollbackState: SamlIdpRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSamlIdps(client)
    const byName = new Map(existing.filter((p) => p.name).map((p) => [idpKey(p.name as string), p]))

    for (const spec of specs) {
      const label = spec.name
      const key = idpKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const prior = await readSamlIdp(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })
        const res = await client.graphql<MutateIdpResult>(UPDATE_SAML_IDP_MUTATION, {
          input: { id: live.id, patch: buildIdpPatch(spec) },
        })
        assertMutationOk(res.transportError, res.errors, `update SAML identity provider "${label}"`)
      } else {
        const res = await client.graphql<MutateIdpResult>(CREATE_SAML_IDP_MUTATION, {
          input: buildIdpInput(spec),
        })
        assertMutationOk(res.transportError, res.errors, `create SAML identity provider "${label}"`)
        const id = res.data?.createSAMLIdentityProvider?.samlIdentityProvider?.id
        if (!id) throw new Error(`SAML identity provider "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz SAML identity provider(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedProviders: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `SAML identity provider deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedProviders: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all SAML identity providers; throws on error. */
export async function listSamlIdps(client: WizClient): Promise<LiveSamlIdp[]> {
  const res = await client.listConnection<LiveSamlIdp>(LIST_SAML_IDPS_QUERY, 'samlIdentityProviders', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Wiz SAML identity providers: ${res.error}`)
  return res.nodes
}

/** Read one provider's full managed state; throws on error. */
export async function readSamlIdp(client: WizClient, id: string): Promise<FullSamlIdp> {
  const res = await client.graphql<GetIdpResult>(GET_SAML_IDP_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read SAML identity provider ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read SAML identity provider ${id}: ${graphqlErrorMessage(res.errors)}`)
  const idp = res.data?.samlIdentityProvider
  if (!idp) throw new Error(`SAML identity provider ${id} was not found`)
  return idp
}

/** Build the `[SAMLGroupMappingCreateInput]` / `[SAMLGroupMappingUpdateInput]` list for a spec (same shape both ways). */
function buildGroupMappingInput(spec: SamlIdpSpec): Array<Record<string, unknown>> {
  return (spec.groupMapping ?? []).map((m) => ({
    providerGroupId: m.providerGroupId,
    role: m.role,
    projects: m.projects,
  }))
}

/** The `CreateSAMLIdentityProviderInput` for a spec. */
export function buildIdpInput(spec: SamlIdpSpec): Record<string, unknown> {
  return {
    name: spec.name,
    issuerURL: spec.issuerUrl,
    loginURL: spec.loginUrl,
    logoutURL: spec.logoutUrl,
    useProviderManagedRoles: spec.useProviderManagedRoles,
    allowManualRoleOverride: spec.allowManualRoleOverride,
    certificate: spec.certificate,
    domains: spec.domains,
    mergeGroupsMappingByRole: spec.mergeGroupsMappingByRole,
    groupMapping: buildGroupMappingInput(spec),
  }
}

/** The `UpdateSAMLIdentityProviderPatch` for a spec (same managed fields as create). */
export function buildIdpPatch(spec: SamlIdpSpec): Record<string, unknown> {
  return {
    name: spec.name,
    issuerURL: spec.issuerUrl,
    loginURL: spec.loginUrl,
    logoutURL: spec.logoutUrl,
    useProviderManagedRoles: spec.useProviderManagedRoles,
    allowManualRoleOverride: spec.allowManualRoleOverride,
    certificate: spec.certificate,
    domains: spec.domains,
    groupMapping: buildGroupMappingInput(spec),
    mergeGroupsMappingByRole: spec.mergeGroupsMappingByRole,
  }
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
