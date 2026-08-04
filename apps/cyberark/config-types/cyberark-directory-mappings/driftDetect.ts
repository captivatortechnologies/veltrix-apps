import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapMappings, resolveDirectoryId } from './deploy'
import { extractDirectoryMappingSpecs, mappingKey, type DirectoryMappingSpec, type LiveDirectoryMapping } from './validate'

/**
 * Detect drift between the deployed directory-mapping configuration and the
 * live PVWA. Re-finds each declared mapping by (directory, name) and diffs
 * the managed fields; a missing mapping is critical drift.
 *
 * Mappings carry no creator/modifier metadata over this API, so diffs are
 * reported without an actor.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDirectoryMappingSpecs(ctx.deployedConfig).filter((s) => s.directoryName && s.mappingName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const directoryIds = new Map<string, string>()
    const mappingsByDirectory = new Map<string, Map<string, LiveDirectoryMapping>>()

    for (const spec of specs) {
      const label = `${spec.mappingName} @ ${spec.directoryName}`
      let directoryId: string
      try {
        directoryId = await resolveDirectoryId(client, spec.directoryName, directoryIds)
      } catch {
        diffs.push({ field: mappingKey(spec), expected: 'exists', actual: 'directory missing', severity: 'critical' })
        continue
      }
      if (!mappingsByDirectory.has(directoryId)) mappingsByDirectory.set(directoryId, await mapMappings(client, directoryId))
      const found = mappingsByDirectory.get(directoryId)?.get(spec.mappingName.toLowerCase())

      if (!found) {
        diffs.push({ field: mappingKey(spec), expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      pushFieldDiffs(diffs, label, spec, found)
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}

function sameList(a: string[], b: string[] | undefined): boolean {
  const bb = b ?? []
  if (a.length !== bb.length) return false
  const as = [...a].sort()
  const bs = [...bb].sort()
  return as.every((v, i) => v === bs[i])
}

/** Diff each managed field of a mapping against its live value. */
function pushFieldDiffs(diffs: DriftDiff[], label: string, spec: DirectoryMappingSpec, live: LiveDirectoryMapping): void {
  if (!sameList(spec.domainGroups, live.DomainGroups)) {
    diffs.push({ field: `${label}.domain_groups`, expected: spec.domainGroups.join(', '), actual: (live.DomainGroups ?? []).join(', ') || 'not set', severity: 'warning' })
  }
  if (!sameList(spec.vaultGroups, live.VaultGroups)) {
    diffs.push({ field: `${label}.vault_groups`, expected: spec.vaultGroups.join(', '), actual: (live.VaultGroups ?? []).join(', ') || 'not set', severity: 'warning' })
  }
  if (!sameList(spec.mappingAuthorizations, live.MappingAuthorizations)) {
    diffs.push({ field: `${label}.mapping_authorizations`, expected: spec.mappingAuthorizations.join(', '), actual: (live.MappingAuthorizations ?? []).join(', ') || 'not set', severity: 'warning' })
  }
  if (spec.location && spec.location !== (live.Location ?? '')) {
    diffs.push({ field: `${label}.location`, expected: spec.location, actual: live.Location ?? 'not set', severity: 'info' })
  }
  const liveDisable = live.DisableUser === true || live.DisableUser === 'true'
  if (spec.disableUser !== liveDisable) {
    diffs.push({ field: `${label}.disable_user`, expected: spec.disableUser, actual: liveDisable, severity: 'info' })
  }
}
