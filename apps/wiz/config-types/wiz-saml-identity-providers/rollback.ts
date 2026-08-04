import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import type { FullSamlIdp } from './validate'
import type { SamlIdpRollbackEntry } from './deploy'

const DELETE_SAML_IDP_MUTATION = `
mutation DeleteSAMLIdentityProvider($input: DeleteSAMLIdentityProviderInput!) {
  deleteSAMLIdentityProvider(input: $input) {
    _stub
  }
}`

const UPDATE_SAML_IDP_MUTATION = `
mutation UpdateSAMLIdentityProvider($input: UpdateSAMLIdentityProviderInput!) {
  updateSAMLIdentityProvider(input: $input) {
    samlIdentityProvider { id }
  }
}`

/**
 * Roll back SAML identity providers using the state captured during deploy:
 *   - providers that were created are deleted (deleteSAMLIdentityProvider)
 *   - providers that were updated are restored to their captured prior state
 *     via an update patch (updateSAMLIdentityProvider), preserving group
 *     mapping role/project ids.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SamlIdpRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_SAML_IDP_MUTATION, { input: { id: entry.id } })
          if (res.transportError) throw new Error(`Failed to delete SAML identity provider "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to delete SAML identity provider "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_SAML_IDP_MUTATION, {
          input: { id: entry.id, patch: priorToPatch(entry.prior) },
        })
        if (res.transportError) throw new Error(`Failed to restore SAML identity provider "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore SAML identity provider "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Wiz SAML identity provider(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update patch from a captured prior provider state. */
function priorToPatch(prior: FullSamlIdp): Record<string, unknown> {
  const groupMapping = (prior.groupMapping ?? []).map((m) => ({
    providerGroupId: m.providerGroupId ?? '',
    role: m.role?.id ?? '',
    projects: (m.projects ?? []).map((p) => p.id).filter((id): id is string => typeof id === 'string' && id.length > 0),
  }))

  return {
    name: prior.name ?? '',
    issuerURL: prior.issuerURL ?? '',
    loginURL: prior.loginURL ?? '',
    logoutURL: prior.logoutURL ?? '',
    useProviderManagedRoles: prior.useProviderManagedRoles ?? false,
    allowManualRoleOverride: prior.allowManualRoleOverride ?? true,
    certificate: prior.certificate ?? '',
    domains: prior.domains ?? [],
    mergeGroupsMappingByRole: prior.mergeGroupsMappingByRole ?? false,
    groupMapping,
  }
}
