import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, graphqlErrorMessage, mutationOkError, type TwingateClient } from '../../lib/twingateApi'
import {
  CREATE_DNS_FILTERING_PROFILE_MUTATION,
  GET_DNS_FILTERING_PROFILE_QUERY,
  LIST_DNS_FILTERING_PROFILES_QUERY,
  LIST_GROUPS_QUERY,
  UPDATE_DNS_FILTERING_PROFILE_MUTATION,
  assertMutationOk,
  buildUpdateVariables,
  byName,
  extractDnsFilteringProfileSpecs,
  profileKey,
  type CreateMutationResponse,
  type DnsFilteringProfileSpec,
  type FullDnsFilteringProfile,
  type LiveDnsFilteringProfile,
  type NamedRef,
  type UpdateMutationResponse,
} from './_shared'

const PAGE_SIZE = 200

export interface ProfileRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullDnsFilteringProfile
}

interface GetProfileResult {
  dnsFilteringProfile?: FullDnsFilteringProfile
}

/**
 * Deploy Twingate DNS Filtering Profiles via the GraphQL API.
 *
 * Identity is the profile `name`. `dnsFilteringProfileCreate` only accepts
 * `name` — so creating a new profile is always create-then-immediately-update
 * (setting the rest of the declared spec). An existing profile is read in
 * full (for rollback) then updated directly. `group_names` are resolved to
 * ids against the live tenant; a name that doesn't resolve aborts the deploy.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractDnsFilteringProfileSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ProfileRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listProfiles(client)
    const byNameMap = new Map(existing.filter((p) => p.name).map((p) => [profileKey(p.name as string), p]))

    const needsGroups = specs.some((s) => s.groupNames.length > 0)
    const groupsByName = needsGroups ? byName(await listGroups(client)) : new Map<string, NamedRef>()

    for (const spec of specs) {
      const label = spec.name
      const key = profileKey(spec.name)
      const groupIds = resolveGroupIds(spec, label, groupsByName)

      const live = byNameMap.get(key)
      if (live && live.id) {
        const liveId: string = live.id
        const prior = await readProfile(client, liveId)
        rollbackState.push({ key, label, existed: true, id: liveId, prior })
        const res = await client.graphql<UpdateMutationResponse>(
          UPDATE_DNS_FILTERING_PROFILE_MUTATION,
          buildUpdateVariables(liveId, spec, groupIds),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.dnsFilteringProfileUpdate),
          `update DNS Filtering Profile "${label}"`,
        )
      } else {
        const created = await client.graphql<CreateMutationResponse>(CREATE_DNS_FILTERING_PROFILE_MUTATION, { name: spec.name })
        assertMutationOk(
          created.transportError,
          created.errors,
          mutationOkError(created.data?.dnsFilteringProfileCreate),
          `create DNS Filtering Profile "${label}"`,
        )
        const id = created.data?.dnsFilteringProfileCreate?.entity?.id
        if (!id) throw new Error(`DNS Filtering Profile "${label}" was created but Twingate returned no id`)

        const res = await client.graphql<UpdateMutationResponse>(UPDATE_DNS_FILTERING_PROFILE_MUTATION, buildUpdateVariables(id, spec, groupIds))
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.dnsFilteringProfileUpdate),
          `apply full spec to newly created DNS Filtering Profile "${label}"`,
        )

        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Twingate DNS Filtering Profile(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedProfiles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `DNS Filtering Profile deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedProfiles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (reused by driftDetect / healthCheck) ----------------------------

/** Resolve a spec's declared group names to ids; throws on any name that doesn't resolve. */
export function resolveGroupIds(spec: DnsFilteringProfileSpec, label: string, groupsByName: Map<string, NamedRef>): string[] {
  const ids: string[] = []
  for (const groupName of spec.groupNames) {
    const group = groupsByName.get(profileKey(groupName))
    if (!group?.id) throw new Error(`DNS Filtering Profile "${label}": Group "${groupName}" was not found in Twingate`)
    ids.push(group.id)
  }
  return ids
}

/** List all DNS Filtering Profiles (light shape); throws on error. */
export async function listProfiles(client: TwingateClient): Promise<LiveDnsFilteringProfile[]> {
  const res = await client.listConnection<LiveDnsFilteringProfile>(LIST_DNS_FILTERING_PROFILES_QUERY, 'dnsFilteringProfiles', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate DNS Filtering Profiles: ${res.error}`)
  return res.nodes
}

/** List all Groups (light shape); throws on error. */
export async function listGroups(client: TwingateClient): Promise<NamedRef[]> {
  const res = await client.listConnection<NamedRef>(LIST_GROUPS_QUERY, 'groups', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Groups: ${res.error}`)
  return res.nodes
}

/** Read one profile's full managed state; throws on error. */
export async function readProfile(client: TwingateClient, id: string): Promise<FullDnsFilteringProfile> {
  const res = await client.graphql<GetProfileResult>(GET_DNS_FILTERING_PROFILE_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read DNS Filtering Profile ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read DNS Filtering Profile ${id}: ${graphqlErrorMessage(res.errors)}`)
  const profile = res.data?.dnsFilteringProfile
  if (!profile) throw new Error(`DNS Filtering Profile ${id} was not found`)
  return profile
}
