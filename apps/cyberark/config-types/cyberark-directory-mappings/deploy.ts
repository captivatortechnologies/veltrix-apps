import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { cyberArkErrorMessage, parseCollectionArray, parseJson, buildCyberArkClient, type CyberArkClient } from '../../lib/cyberark'
import { extractDirectoryMappingSpecs, mappingKey, type DirectoryMappingSpec, type LiveDirectory, type LiveDirectoryMapping } from './validate'

/**
 * Rollback state for one mapping. `prior` carries the live mapping so an
 * updated mapping can be restored field-for-field (a full-replace PUT).
 */
export interface DirectoryMappingRollbackEntry {
  key: string
  label: string
  directoryId: string
  existed: boolean
  mappingId?: string
  prior?: LiveDirectoryMapping
}

/**
 * Deploy CyberArk LDAP directory mappings via the PVWA Gen2 REST API.
 *
 * The directory itself must already exist (see validate.ts — creating one
 * needs a BindPassword this app never handles); `directory_name` is resolved
 * to CyberArk's internal directory id once per deploy. Identity within a
 * directory is the MappingName: list its mappings, match on MappingName, then
 * PUT an existing mapping by its MappingID (a full replace) or POST a new one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractDirectoryMappingSpecs(ctx.canvas).filter((s) => s.directoryName && s.mappingName && s.domainGroups.length > 0)
  const rollbackState: DirectoryMappingRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const directoryIds = new Map<string, string>()
    const mappingsByDirectory = new Map<string, Map<string, LiveDirectoryMapping>>()

    for (const spec of specs) {
      const label = `${spec.mappingName} @ ${spec.directoryName}`
      const key = mappingKey(spec)
      const directoryId = await resolveDirectoryId(client, spec.directoryName, directoryIds)

      if (!mappingsByDirectory.has(directoryId)) mappingsByDirectory.set(directoryId, await mapMappings(client, directoryId))
      const mappings = mappingsByDirectory.get(directoryId) as Map<string, LiveDirectoryMapping>
      const live = mappings.get(spec.mappingName.toLowerCase())

      if (live?.MappingID !== undefined) {
        rollbackState.push({ key, label, directoryId, existed: true, mappingId: String(live.MappingID), prior: live })
        const res = await client.request('PUT', `/Configuration/LDAP/Directories/${encodeURIComponent(directoryId)}/Mappings/${encodeURIComponent(String(live.MappingID))}`, {
          body: buildMappingBody(spec, live.MappingID),
        })
        if (!res.ok) throw new Error(`Failed to update mapping "${label}": ${cyberArkErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', `/Configuration/LDAP/Directories/${encodeURIComponent(directoryId)}/Mappings/`, {
          body: buildMappingBody(spec),
        })
        if (!res.ok) throw new Error(`Failed to create mapping "${label}": ${cyberArkErrorMessage(res)}`)
        const created = parseJson<LiveDirectoryMapping>(res.body)
        rollbackState.push({ key, label, directoryId, existed: false, mappingId: created?.MappingID !== undefined ? String(created.MappingID) : undefined })
      }
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} directory mapping(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      artifacts: { pvwaUrl, deployedMappings: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Directory mapping deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedMappings: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** List all LDAP directories; throws on a non-OK response. */
export async function listDirectories(client: CyberArkClient): Promise<LiveDirectory[]> {
  const res = await client.request('GET', '/Configuration/LDAP/Directories/')
  if (!res.ok) throw new Error(`Failed to list LDAP directories: ${cyberArkErrorMessage(res)}`)
  return parseCollectionArray<LiveDirectory>(res.body, ['value', 'Directories'])
}

/**
 * Resolve a directory name to its internal id (cached per deploy). Throws
 * when no existing directory matches — this type never creates a directory.
 */
export async function resolveDirectoryId(client: CyberArkClient, name: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(name.toLowerCase())
  if (cached !== undefined) return cached
  const directories = await listDirectories(client)
  for (const dir of directories) {
    const dirName = dir.DirectoryName ?? dir.Name
    const id = dir.id ?? dir.DirectoryID ?? dir.LDAPID
    if (typeof dirName === 'string' && dirName && id !== undefined) {
      cache.set(dirName.toLowerCase(), String(id))
    }
  }
  const id = cache.get(name.toLowerCase())
  if (id === undefined) {
    throw new Error(`LDAP directory "${name}" was not found — provision it in PVWA first (this app manages mappings only, never the directory connection itself)`)
  }
  return id
}

/** List a directory's mappings; throws on a non-OK response. */
export async function listMappings(client: CyberArkClient, directoryId: string): Promise<LiveDirectoryMapping[]> {
  const res = await client.request('GET', `/Configuration/LDAP/Directories/${encodeURIComponent(directoryId)}/Mappings`)
  if (!res.ok) throw new Error(`Failed to list mappings for directory ${directoryId}: ${cyberArkErrorMessage(res)}`)
  return parseCollectionArray<LiveDirectoryMapping>(res.body, ['value', 'Mappings'])
}

/** Index a directory's mappings by MappingName (lower-cased). */
export async function mapMappings(client: CyberArkClient, directoryId: string): Promise<Map<string, LiveDirectoryMapping>> {
  const mappings = await listMappings(client, directoryId)
  return new Map(mappings.filter((m) => typeof m.MappingName === 'string' && m.MappingName).map((m) => [(m.MappingName as string).toLowerCase(), m]))
}

/** Build the create/update body shared by POST and PUT (a full replace on update). */
export function buildMappingBody(spec: DirectoryMappingSpec, mappingId?: string | number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    MappingName: spec.mappingName,
    DomainGroups: spec.domainGroups,
    VaultGroups: spec.vaultGroups,
    MappingAuthorizations: spec.mappingAuthorizations,
    Location: spec.location,
    UserType: spec.userType,
    DisableUser: spec.disableUser,
  }
  if (spec.ldapBranch) body.LDAPBranch = spec.ldapBranch
  if (spec.authenticationMethod.length > 0) body.AuthenticationMethod = spec.authenticationMethod
  if (spec.userActivityLogPeriod !== null) body.UserActivityLogPeriod = spec.userActivityLogPeriod
  if (spec.userExpiration !== null) body.UserExpiration = spec.userExpiration
  if (spec.logonFromHour !== null) body.LogonFromHour = spec.logonFromHour
  if (spec.logonToHour !== null) body.LogonToHour = spec.logonToHour
  if (mappingId !== undefined) body.MappingID = mappingId
  return body
}
