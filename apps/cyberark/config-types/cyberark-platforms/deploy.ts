import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCyberArkClient,
  cyberArkErrorMessage,
  parseCollectionArray,
  parseJson,
  type CyberArkClient,
} from '../../lib/cyberark'
import { extractPlatformSpecs, platformKey, type LivePlatform, type PlatformSpec } from './validate'

/**
 * Rollback state for one platform. `priorActive` is captured for an updated
 * platform so its active state can be restored. The write-only import package is
 * never read back or stored.
 */
export interface PlatformRollbackEntry {
  key: string
  label: string
  existed: boolean
  /** Numeric platform ID (needed to activate / deactivate / delete). */
  id?: number
  priorActive?: boolean
}

/**
 * Deploy CyberArk target platforms via the PVWA REST API.
 *
 * Identity is the PlatformID: list /Platforms/Targets, match on PlatformID, then
 *   - if present: reconcile the active state (activate / deactivate) to the spec.
 *   - if missing: import it from the supplied BASE 64 package (POST
 *     /Platforms/Import), re-read to resolve its numeric ID, then reconcile.
 *
 * ⚠ PACKAGE: the import package is WRITE-ONLY and sent ONLY when importing a
 * missing platform. It is never read back, diffed, or stored in rollbackData /
 * artifacts / error messages.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractPlatformSpecs(ctx.canvas).filter((s) => s.platformId)
  const rollbackState: PlatformRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    let byKey = await mapPlatforms(client)

    for (const spec of specs) {
      const label = spec.platformId
      const key = platformKey(spec)
      let live = byKey.get(key)

      if (!live) {
        if (!spec.importPackage) {
          throw new Error(
            `Platform "${label}" was not found and no import package was provided — supply a ` +
              'BASE 64 platform package to create it, or manage an existing platform.',
          )
        }
        const res = await client.request('POST', '/Platforms/Import/', {
          body: { ImportFile: spec.importPackage }, // ⚠ write-only — import only
        })
        if (!res.ok) throw new Error(`Failed to import platform "${label}": ${cyberArkErrorMessage(res)}`)
        // Re-read so we have the numeric ID + current active state to reconcile.
        byKey = await mapPlatforms(client)
        live = byKey.get(key)
        const created = parseJson<{ PlatformID?: string }>(res.body)
        rollbackState.push({ key, label, existed: false, id: live?.ID })
        if (live?.ID !== undefined) createdIds.push(live.ID)
        if (!live) {
          // Imported but not yet listable — record and move on (active state
          // cannot be reconciled without the numeric ID).
          deployed.push(created?.PlatformID ?? label)
          continue
        }
      } else {
        rollbackState.push({ key, label, existed: true, id: live.ID, priorActive: live.Active })
      }

      await reconcileActive(client, label, live, spec)
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} platform(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      artifacts: { pvwaUrl, deployedPlatforms: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Platform deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedPlatforms: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all target platforms; throws on a non-OK response. */
export async function listTargetPlatforms(client: CyberArkClient): Promise<LivePlatform[]> {
  const res = await client.request('GET', '/Platforms/Targets')
  if (!res.ok) {
    throw new Error(`Failed to list platforms: ${cyberArkErrorMessage(res)}`)
  }
  return parseCollectionArray<LivePlatform>(res.body, ['Platforms'])
}

/** Index live target platforms by their natural key (PlatformID, lower-cased). */
export async function mapPlatforms(client: CyberArkClient): Promise<Map<string, LivePlatform>> {
  const platforms = await listTargetPlatforms(client)
  return new Map(
    platforms
      .filter((p) => typeof p.PlatformID === 'string' && p.PlatformID)
      .map((p) => [platformKey({ platformId: p.PlatformID as string }), p]),
  )
}

/**
 * Activate or deactivate a platform so its live state matches the spec. A no-op
 * when the state already matches or the numeric ID is unknown. Throws on failure.
 */
async function reconcileActive(
  client: CyberArkClient,
  label: string,
  live: LivePlatform,
  spec: PlatformSpec,
): Promise<void> {
  if (live.ID === undefined || (live.Active ?? false) === spec.active) return
  const action = spec.active ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/Platforms/Targets/${live.ID}/${action}/`)
  if (!res.ok) throw new Error(`Failed to ${action} platform "${label}": ${cyberArkErrorMessage(res)}`)
}
