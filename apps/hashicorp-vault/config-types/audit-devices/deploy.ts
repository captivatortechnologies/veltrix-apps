import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildVaultClient,
  parseJson,
  vaultErrorMessage,
  type VaultClient,
} from '../../lib/vault'
import {
  buildAuditOptions,
  extractAuditDeviceSpecs,
  normalizeAuditPath,
  type AuditDeviceSpec,
  type LiveAuditDevice,
} from './validate'

export interface AuditDeviceRollbackEntry {
  path: string
  /** Whether the device already existed before this deploy touched the path. */
  existed: boolean
  /**
   * For a device that existed and was RE-ENABLED with new config, the ORIGINAL
   * live config so rollback can disable-then-re-enable back to it. Absent for a
   * device this deploy created (rollback simply disables it).
   */
  prior?: { type: string; description: string; options: Record<string, string> }
}

/**
 * Deploy audit devices to a Vault cluster via the sys/audit API.
 *
 * An audit device logs every request Vault handles to a backend; its identity is
 * its mount PATH. There is NO tune endpoint, so the only ways to change a device
 * are to enable it or to disable + re-enable it. For each declared device:
 *   - GET    /sys/audit          — list, then match on the normalized path
 *   - PUT    /sys/audit/{path}   — enable a missing device (capture created path)
 *   - DELETE + PUT /sys/audit/{path} — when type or options differ, disable then
 *     re-enable IN THAT ORDER (capture the prior config for rollback)
 *
 * SAFETY: while a device is being re-enabled there is a brief window with NO
 * audit logging at that path, and a device pointed at an unwritable file or a
 * dead syslog/socket target can BLOCK Vault (it refuses requests when it cannot
 * log). The success message calls both out.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAuditDeviceSpecs(ctx.canvas).filter((s) => s.path && s.type)
  const rollbackState: AuditDeviceRollbackEntry[] = []
  const createdPaths: string[] = []
  const reenabledPaths: string[] = []
  const deployed: string[] = []

  try {
    // One list call resolves every device — the map is keyed by "<path>/".
    const liveMap = await listAuditDevices(client)

    for (const spec of specs) {
      const live = findLiveDevice(liveMap, spec.path)
      const desiredOptions = buildAuditOptions(spec)

      if (!live) {
        // Absent → enable. A bad target can block Vault, so this may fail loudly.
        const res = await client.request('PUT', `/sys/audit/${spec.path}`, {
          body: buildEnableBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to enable audit device "${spec.path}": ${vaultErrorMessage(res)}`)
        }
        rollbackState.push({ path: spec.path, existed: false })
        createdPaths.push(spec.path)
      } else if (live.type === spec.type && optionsMatch(desiredOptions, live.options)) {
        // Present with the SAME type + managed options → nothing to do.
      } else {
        // type or options differ. There is no tune endpoint, so the only way to
        // converge is to disable then re-enable — IN THAT ORDER, per path.
        const prior = {
          type: live.type ?? '',
          description: live.description ?? '',
          options: normalizeLiveOptions(live.options),
        }

        const del = await client.request('DELETE', `/sys/audit/${spec.path}`)
        if (!del.ok && del.status !== 404) {
          throw new Error(
            `Failed to disable audit device "${spec.path}" before re-enabling: ${vaultErrorMessage(del)}`,
          )
        }
        // From here auditing is OFF at this path until the re-enable succeeds.
        // Record the prior config only now that the disable succeeded, so
        // rollback never re-enables a device we left untouched.
        rollbackState.push({ path: spec.path, existed: true, prior })

        const put = await client.request('PUT', `/sys/audit/${spec.path}`, {
          body: buildEnableBody(spec),
        })
        if (!put.ok) {
          throw new Error(
            `Audit device "${spec.path}" was disabled but could NOT be re-enabled: ${vaultErrorMessage(put)}. ` +
              'There is now no audit device at this path — if it was the only audit device, Vault may refuse ' +
              'requests until an audit device is restored.',
          )
        }
        reenabledPaths.push(spec.path)
      }

      deployed.push(spec.path)
    }

    let message = `Deployed ${deployed.length} audit device(s) to Vault at ${baseUrl}: ${deployed.join(', ')}.`
    if (reenabledPaths.length > 0) {
      message +=
        ` Re-enabled (disable → re-enable) ${reenabledPaths.join(', ')} — there was a brief window with ` +
        'no audit logging at each path during the swap.'
    }
    if (createdPaths.length > 0 || reenabledPaths.length > 0) {
      message +=
        ' Note: an audit device pointed at an unwritable file path or a dead syslog/socket target can ' +
        'BLOCK Vault (it refuses requests when it cannot write its audit log) — verify each target is reachable.'
    }

    return {
      success: true,
      message,
      artifacts: { baseUrl, deployedDevices: deployed, reenabledDevices: reenabledPaths },
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  } catch (error) {
    return {
      success: false,
      message: `Audit device deployment failed after ${deployed.length} of ${specs.length} device(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedDevices: deployed, reenabledDevices: reenabledPaths },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  }
}

// --- Helpers ---

/**
 * List every enabled audit device; returns the map keyed by "<path>/". A plain
 * GET /sys/audit returns the device map under `data` (with a legacy copy at the
 * top level) — prefer `data` when present.
 */
export async function listAuditDevices(client: VaultClient): Promise<Record<string, LiveAuditDevice>> {
  const res = await client.request('GET', '/sys/audit')
  if (!res.ok) {
    throw new Error(`Failed to list audit devices: ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<Record<string, unknown>>(res.body) ?? {}
  const data =
    parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, LiveAuditDevice>) : undefined
  return data ?? (parsed as Record<string, LiveAuditDevice>)
}

/** Find a live device by path, tolerating the trailing slash Vault stores. */
export function findLiveDevice(
  map: Record<string, LiveAuditDevice>,
  path: string,
): LiveAuditDevice | null {
  const target = normalizeAuditPath(path)
  for (const [key, value] of Object.entries(map)) {
    if (normalizeAuditPath(key) === target) return value
  }
  return null
}

/** True when every managed option matches the live value (string-compared). */
function optionsMatch(desired: Record<string, string>, live: Record<string, unknown> | undefined): boolean {
  const liveOptions = live ?? {}
  // Only the options THIS deploy manages are compared — Vault fills in many
  // defaults (mode, format, hmac_accessor …) we neither send nor own.
  return Object.keys(desired).every((key) => String(liveOptions[key] ?? '') === String(desired[key]))
}

/** Coerce a live options map (Vault returns string values) to Record<string,string>. */
function normalizeLiveOptions(options: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(options ?? {})) out[key] = String(value)
  return out
}

/** Build the PUT /sys/audit/{path} enable body from a spec. */
function buildEnableBody(spec: AuditDeviceSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { type: spec.type, options: buildAuditOptions(spec) }
  if (spec.description) body.description = spec.description
  return body
}
