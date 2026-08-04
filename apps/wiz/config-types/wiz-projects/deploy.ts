import { randomUUID } from 'crypto'
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type GraphQLError, type WizClient } from '../../lib/wiz'
import { extractProjectSpecs, isJsonObject, projectKey, type FullProject, type LiveProject, type ProjectSpec } from './validate'

// --- GraphQL operations --------------------------------------------------------
//
// createProject / GetProject are VERIFIED verbatim against terraform-provider-
// wiz's resource_project.go (github.com/AxtonGrams/terraform-provider-wiz).
// updateProject is VERIFIED to use the `UpdateProjectInput.override` field
// (a FULL replace of every managed field, not a sparse `patch`) — the
// reference provider's own comment: "the update requires an empty value to
// nullify removed attributes". That same file's resourceWizProjectDelete
// documents, verbatim: "Wiz does not support deleting projects, so we fake it
// by setting archived=true" and "we set the project name to the slug uid to
// avoid conflicts" (project names must be unique tenant-wide, so an archived
// project must free its name). This app's rollback of a CREATED project
// follows that exact verified pattern — see rollback.ts.
//
// The `projects` list query below is NOT directly exercised by that reference
// provider (Terraform tracks identity via its own state file) — it is
// inferred from the now-repeated plural-list / singular-by-id naming
// convention this app already relies on elsewhere in this schema.

/** List projects (Relay connection). */
export const LIST_PROJECTS_QUERY = `
query ListProjects($first: Int, $after: String) {
  projects(first: $first, after: $after) {
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

/** Read a single project's full managed state (for update + restore). VERIFIED. */
export const GET_PROJECT_QUERY = `
query GetProject($id: ID) {
  project(id: $id) {
    id
    name
    isFolder
    ancestorProjects {
      id
    }
    description
    identifiers
    slug
    archived
    businessUnit
    projectOwners {
      id
    }
    securityChampions {
      id
    }
    riskProfile {
      businessImpact
      isActivelyDeveloped
      hasAuthentication
      hasExposedAPI
      isInternetFacing
      isCustomerFacing
      storesData
      sensitiveDataTypes
      isRegulated
      regulatoryStandards
    }
    cloudOrganizationLinks {
      cloudOrganization { id }
      resourceTags { key value }
      resourceGroups
      shared
      environment
    }
    cloudAccountLinks {
      cloudAccount { id }
      resourceTags { key value }
      resourceGroups
      shared
      environment
    }
    kubernetesClustersLinks {
      kubernetesCluster { id }
      environment
      namespaces
      shared
    }
  }
}`

/** VERIFIED against resource_project.go. */
const CREATE_PROJECT_MUTATION = `
mutation CreateProject($input: CreateProjectInput!) {
  createProject(input: $input) {
    project { id }
  }
}`

/** VERIFIED against resource_project.go — note the `override` (not `patch`) input field. */
const UPDATE_PROJECT_MUTATION = `
mutation UpdateProject($input: UpdateProjectInput!) {
  updateProject(input: $input) {
    project { id }
  }
}`

const PAGE_SIZE = 100

export interface ProjectRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** The slug this app assigned at creation — needed to archive+rename on rollback (Wiz has no delete). */
  createdSlug?: string
  prior?: FullProject
}

interface MutateProjectResult {
  createProject?: { project?: { id?: string } }
  updateProject?: { project?: { id?: string } }
}

interface GetProjectResult {
  project?: FullProject
}

/**
 * Deploy Wiz projects via the GraphQL API.
 *
 * Identity is the project `name`: list the tenant's projects, match on the
 * name, then update it (capturing its prior full state for rollback) or
 * create a new one. Wiz has no deleteProject mutation — see rollback.ts for
 * how this app undoes a project it created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractProjectSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ProjectRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listProjects(client)
    const byName = new Map(existing.filter((p) => p.name).map((p) => [projectKey(p.name as string), p]))

    for (const spec of specs) {
      const label = spec.name
      const key = projectKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const prior = await readProject(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })
        const res = await client.graphql<MutateProjectResult>(UPDATE_PROJECT_MUTATION, {
          input: { id: live.id, override: buildProjectOverride(spec, prior.slug ?? randomUUID()) },
        })
        assertMutationOk(res.transportError, res.errors, `update project "${label}"`)
      } else {
        const slug = randomUUID()
        const res = await client.graphql<MutateProjectResult>(CREATE_PROJECT_MUTATION, {
          input: buildProjectInput(spec, slug),
        })
        assertMutationOk(res.transportError, res.errors, `create project "${label}"`)
        const id = res.data?.createProject?.project?.id
        if (!id) throw new Error(`Project "${label}" was created but Wiz returned no id`)
        rollbackState.push({ key, label, existed: false, id, createdSlug: slug })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Wiz project(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedProjects: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Project deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedProjects: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all projects; throws on error. */
export async function listProjects(client: WizClient): Promise<LiveProject[]> {
  const res = await client.listConnection<LiveProject>(LIST_PROJECTS_QUERY, 'projects', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Wiz projects: ${res.error}`)
  return res.nodes
}

/** Read one project's full managed state; throws on error. */
export async function readProject(client: WizClient, id: string): Promise<FullProject> {
  const res = await client.graphql<GetProjectResult>(GET_PROJECT_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read project ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read project ${id}: ${graphqlErrorMessage(res.errors)}`)
  const project = res.data?.project
  if (!project) throw new Error(`Project ${id} was not found`)
  return project
}

/** Extract the (optional) resource-link arrays from the spec's parsed JSON blob. */
function resourceLinksFor(spec: ProjectSpec): {
  cloudAccountLinks: unknown[]
  cloudOrganizationLinks: unknown[]
  kubernetesClusterLinks: unknown[]
} {
  const raw = isJsonObject(spec.resourceLinks) ? spec.resourceLinks : {}
  return {
    cloudAccountLinks: Array.isArray(raw.cloudAccountLinks) ? raw.cloudAccountLinks : [],
    cloudOrganizationLinks: Array.isArray(raw.cloudOrganizationLinks) ? raw.cloudOrganizationLinks : [],
    kubernetesClusterLinks: Array.isArray(raw.kubernetesClusterLinks) ? raw.kubernetesClusterLinks : [],
  }
}

/** The `CreateProjectInput` for a spec. `isFolder` is create-time only. */
export function buildProjectInput(spec: ProjectSpec, slug: string): Record<string, unknown> {
  const links = resourceLinksFor(spec)
  return {
    name: spec.name,
    description: spec.description,
    businessUnit: spec.businessUnit,
    isFolder: spec.isFolder,
    parentProjectId: spec.parentProjectId,
    archived: spec.archived,
    identifiers: spec.identifiers,
    projectOwners: spec.projectOwners,
    securityChampion: spec.securityChampions,
    riskProfile: spec.riskProfile,
    cloudAccountLinks: links.cloudAccountLinks,
    cloudOrganizationLinks: links.cloudOrganizationLinks,
    kubernetesClusterLinks: links.kubernetesClusterLinks,
    slug,
  }
}

/**
 * The FULL `UpdateProjectPatch` override for a spec — every managed field is
 * always sent (Wiz requires this to nullify removed resource links). `slug`
 * must be the project's OWN existing slug — never regenerated on update.
 */
export function buildProjectOverride(spec: ProjectSpec, slug: string): Record<string, unknown> {
  const links = resourceLinksFor(spec)
  return {
    name: spec.name,
    description: spec.description,
    businessUnit: spec.businessUnit,
    parentProjectId: spec.parentProjectId,
    archived: spec.archived,
    identifiers: spec.identifiers,
    projectOwners: spec.projectOwners,
    securityChampions: spec.securityChampions,
    riskProfile: spec.riskProfile,
    cloudAccountLinks: links.cloudAccountLinks,
    cloudOrganizationLinks: links.cloudOrganizationLinks,
    kubernetesClusterLinks: links.kubernetesClusterLinks,
    slug,
  }
}

/** Throw a descriptive error when a mutation failed at the transport or GraphQL level. */
function assertMutationOk(transportError: string | null, errors: GraphQLError[] | null, action: string): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${graphqlErrorMessage(errors)}`)
}
