import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import { buildMappingBody } from './deploy'
import type { DirectoryMappingRollbackEntry } from './deploy'

/**
 * Roll back directory mappings using the state captured during deploy:
 *   - mappings that were created are deleted
 *     (DELETE .../Directories/{id}/Mappings/{mappingId})
 *   - mappings that were updated are restored (PUT, full replace) to their
 *     prior field values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DirectoryMappingRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.mappingId) {
        reverted.push(entry.label)
        continue
      }
      if (!entry.existed) {
        const res = await client.request('DELETE', `/Configuration/LDAP/Directories/${encodeURIComponent(entry.directoryId)}/Mappings/${encodeURIComponent(entry.mappingId)}/`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete mapping "${entry.label}": ${cyberArkErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const restoreSpec = liveToSpec(entry.prior)
        const res = await client.request('PUT', `/Configuration/LDAP/Directories/${encodeURIComponent(entry.directoryId)}/Mappings/${encodeURIComponent(entry.mappingId)}`, {
          body: buildMappingBody(restoreSpec, entry.prior.MappingID),
        })
        if (!res.ok) throw new Error(`Failed to restore mapping "${entry.label}": ${cyberArkErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} directory mapping(s): ${reverted.join(', ')}` }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Map a captured live mapping back to the spec shape buildMappingBody() expects. */
function liveToSpec(prior: DirectoryMappingRollbackEntry['prior']): Parameters<typeof buildMappingBody>[0] {
  const p = prior ?? {}
  return {
    sectionName: '',
    directoryName: '',
    mappingName: p.MappingName ?? '',
    domainGroups: p.DomainGroups ?? [],
    ldapBranch: p.LDAPBranch ?? '',
    vaultGroups: p.VaultGroups ?? [],
    mappingAuthorizations: p.MappingAuthorizations ?? [],
    location: p.Location ?? '\\',
    authenticationMethod: p.AuthenticationMethod ?? [],
    userType: p.UserType ?? '',
    disableUser: typeof p.DisableUser === 'boolean' ? p.DisableUser : p.DisableUser === 'true',
    userActivityLogPeriod: p.UserActivityLogPeriod ?? null,
    userExpiration: p.UserExpiration ?? null,
    logonFromHour: p.LogonFromHour ?? null,
    logonToHour: p.LogonToHour ?? null,
  }
}
