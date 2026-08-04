import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import type { FullProject } from './validate'
import type { ProjectRollbackEntry } from './deploy'

const UPDATE_PROJECT_MUTATION = `
mutation UpdateProject($input: UpdateProjectInput!) {
  updateProject(input: $input) {
    project { id }
  }
}`

/**
 * Roll back projects using the state captured during deploy. Wiz has NO
 * deleteProject mutation (verified absent from the schema — see deploy.ts), so:
 *   - projects that were CREATED are archived and renamed to their own slug —
 *     VERIFIED to be exactly how terraform-provider-wiz "deletes" a project
 *     (resourceWizProjectDelete: "Wiz does not support deleting projects, so
 *     we fake it by setting archived=true" + rename to slug to free the name,
 *     since Wiz project names are unique tenant-wide).
 *   - projects that were updated are restored to their captured prior full
 *     state via the same `override` (full-replace) semantics deploy uses.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProjectRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const archived: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id && entry.createdSlug) {
          const res = await client.graphql(UPDATE_PROJECT_MUTATION, {
            input: { id: entry.id, override: { name: entry.createdSlug, slug: entry.createdSlug, archived: true } },
          })
          if (res.transportError) throw new Error(`Failed to archive project "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to archive project "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
          archived.push(entry.label)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_PROJECT_MUTATION, {
          input: { id: entry.id, override: priorToOverride(entry.prior) },
        })
        if (res.transportError) throw new Error(`Failed to restore project "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore project "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
      }
      reverted.push(entry.label)
    }

    const archivedNote =
      archived.length > 0 ? ` (Wiz has no delete API — archived and renamed to free the name: ${archived.join(', ')})` : ''
    return { success: true, message: `Rolled back ${reverted.length} Wiz project(s): ${reverted.join(', ')}${archivedNote}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild a full `override` from a captured prior project state. */
function priorToOverride(prior: FullProject): Record<string, unknown> {
  const ids = (list: Array<{ id?: string }> | undefined): string[] =>
    (list ?? []).map((x) => x.id).filter((id): id is string => typeof id === 'string' && id.length > 0)

  return {
    name: prior.name ?? '',
    description: prior.description ?? '',
    businessUnit: prior.businessUnit ?? '',
    parentProjectId: prior.parentProjectId ?? '',
    archived: prior.archived ?? false,
    identifiers: prior.identifiers ?? [],
    projectOwners: ids(prior.projectOwners),
    securityChampions: ids(prior.securityChampions),
    riskProfile: {
      businessImpact: prior.riskProfile?.businessImpact ?? 'MBI',
      isActivelyDeveloped: prior.riskProfile?.isActivelyDeveloped ?? 'UNKNOWN',
      hasAuthentication: prior.riskProfile?.hasAuthentication ?? 'UNKNOWN',
      hasExposedAPI: prior.riskProfile?.hasExposedAPI ?? 'UNKNOWN',
      isInternetFacing: prior.riskProfile?.isInternetFacing ?? 'UNKNOWN',
      isCustomerFacing: prior.riskProfile?.isCustomerFacing ?? 'UNKNOWN',
      storesData: prior.riskProfile?.storesData ?? 'UNKNOWN',
      isRegulated: prior.riskProfile?.isRegulated ?? 'UNKNOWN',
      sensitiveDataTypes: prior.riskProfile?.sensitiveDataTypes ?? [],
      regulatoryStandards: prior.riskProfile?.regulatoryStandards ?? [],
    },
    cloudAccountLinks: accountLinksToInput(prior.cloudAccountLinks),
    cloudOrganizationLinks: organizationLinksToInput(prior.cloudOrganizationLinks),
    kubernetesClusterLinks: kubernetesClusterLinksToInput(prior.kubernetesClustersLinks),
    slug: prior.slug ?? '',
  }
}

interface ReadResourceTag {
  key?: string
  value?: string
}

/** Convert a read-shaped `cloudAccountLinks` (nested `cloudAccount { id }`) back into the flat write input shape. */
function accountLinksToInput(links: unknown[] | undefined): Array<Record<string, unknown>> {
  return (links ?? []).map((raw) => {
    const link = raw as {
      cloudAccount?: { id?: string }
      environment?: string
      shared?: boolean
      resourceGroups?: string[]
      resourceTags?: ReadResourceTag[]
    }
    return {
      cloudAccount: link.cloudAccount?.id ?? '',
      environment: link.environment ?? 'PRODUCTION',
      shared: link.shared ?? false,
      resourceGroups: link.resourceGroups ?? [],
      resourceTags: (link.resourceTags ?? []).map((t) => ({ key: t.key ?? '', value: t.value ?? '' })),
    }
  })
}

/** Convert a read-shaped `cloudOrganizationLinks` (nested `cloudOrganization { id }`) back into the flat write input shape. */
function organizationLinksToInput(links: unknown[] | undefined): Array<Record<string, unknown>> {
  return (links ?? []).map((raw) => {
    const link = raw as {
      cloudOrganization?: { id?: string }
      environment?: string
      shared?: boolean
      resourceGroups?: string[]
      resourceTags?: ReadResourceTag[]
    }
    return {
      cloudOrganization: link.cloudOrganization?.id ?? '',
      environment: link.environment ?? 'PRODUCTION',
      shared: link.shared ?? true,
      resourceGroups: link.resourceGroups ?? [],
      resourceTags: (link.resourceTags ?? []).map((t) => ({ key: t.key ?? '', value: t.value ?? '' })),
    }
  })
}

/** Convert a read-shaped `kubernetesClustersLinks` (nested `kubernetesCluster { id }`) back into the flat write input shape. */
function kubernetesClusterLinksToInput(links: unknown[] | undefined): Array<Record<string, unknown>> {
  return (links ?? []).map((raw) => {
    const link = raw as { kubernetesCluster?: { id?: string }; environment?: string; shared?: boolean; namespaces?: string[] }
    return {
      kubernetesCluster: link.kubernetesCluster?.id ?? '',
      environment: link.environment ?? 'PRODUCTION',
      shared: link.shared ?? true,
      namespaces: link.namespaces ?? [],
    }
  })
}
