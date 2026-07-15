import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildVaultClient,
  parseJson,
  vaultErrorMessage,
  type VaultClient,
} from '../../lib/vault'
import {
  KV_ENGINE_TYPE,
  extractMountSpecs,
  type LiveMount,
  type LiveMountTune,
  type MountSpec,
} from './validate'

export interface MountRollbackEntry {
  path: string
  type: string
  /** false = deploy ENABLED this mount (rollback disables it — DESTRUCTIVE). */
  existed: boolean
  /** Prior tuning captured before deploy tuned an existing mount (update branch). */
  priorTune?: {
    default_lease_ttl?: string
    max_lease_ttl?: string
    description?: string
  }
}

/**
 * Deploy Vault secret engine mounts via the /sys/mounts API. A mount is
 * CREATE-ONLY + tune: its `type` (and, for kv, its `options.version`) is fixed
 * at enable time and immutable thereafter. For each declared engine the same
 * three-branch decision tree as auth methods is applied:
 *
 *   1. path ABSENT              → POST /sys/mounts/{path}        (enable; captured in createdPaths)
 *   2. path present, SAME type  → POST /sys/mounts/{path}/tune   (converge tunables; prior tune captured)
 *   3. path present, OTHER type → FAIL
 *
 * Branch 3 never disables + re-enables: a mount's type is immutable and the only
 * way to change it is to disable the mount, which PERMANENTLY DESTROYS every
 * secret stored under it. Deploy refuses to do that silently and tells the
 * operator to remove the mount by hand.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractMountSpecs(ctx.canvas).filter((s) => s.path && s.type)
  const rollbackState: MountRollbackEntry[] = []
  const createdPaths: string[] = []
  const deployed: string[] = []
  const versionWarnings: string[] = []

  try {
    for (const spec of specs) {
      const live = await findMount(client, spec.path)

      if (!live) {
        // Branch 1 — absent → enable. options.version (kv only) is emitted here
        // because it can only be set at enable time.
        const res = await client.request('POST', `/sys/mounts/${spec.path}`, {
          body: buildEnableBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to enable secret engine "${spec.path}": ${vaultErrorMessage(res)}`)
        }
        rollbackState.push({ path: spec.path, type: spec.type, existed: false })
        createdPaths.push(spec.path)
      } else if ((live.type ?? '').toLowerCase() !== spec.type) {
        // Branch 3 — present with a DIFFERENT type → FAIL. Never disable+re-enable:
        // a type change is impossible in place and disabling destroys the data.
        throw new Error(
          `Secret engine "${spec.path}" already exists with type "${live.type}", but the configuration requests type "${spec.type}". ` +
            `A mount's type is immutable — changing it would require disabling the mount, which permanently destroys all secrets and data stored under it. ` +
            `Refusing to do this automatically: remove the existing mount manually (vault secrets disable ${spec.path}) if you intend to replace it, then re-deploy.`,
        )
      } else {
        // Branch 2 — present with the SAME type → tune. Capture the prior tuning
        // and description first so rollback can restore them. options/version is
        // enable-only and is intentionally NOT touched here.
        const tune = await getMountTune(client, spec.path)
        rollbackState.push({
          path: spec.path,
          type: spec.type,
          existed: true,
          priorTune: {
            default_lease_ttl: tune?.default_lease_ttl !== undefined ? String(tune.default_lease_ttl) : undefined,
            max_lease_ttl: tune?.max_lease_ttl !== undefined ? String(tune.max_lease_ttl) : undefined,
            description: typeof live.description === 'string' ? live.description : '',
          },
        })

        const res = await client.request('POST', `/sys/mounts/${spec.path}/tune`, {
          body: buildTuneBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to tune secret engine "${spec.path}": ${vaultErrorMessage(res)}`)
        }

        // A KV version cannot be tuned. If the live version differs from the
        // desired one, surface it — the deploy converged everything it could,
        // but the version stays put (driftDetect flags it as unfixable too).
        if (spec.type === KV_ENGINE_TYPE && spec.kvVersion) {
          const liveVersion = readOptionVersion(live.options)
          if (liveVersion && liveVersion !== spec.kvVersion) {
            versionWarnings.push(
              `mount "${spec.path}" is KV v${liveVersion} but the configuration wants v${spec.kvVersion} — a KV version is fixed at enable time and cannot be changed by tuning; recreating the mount would destroy its data`,
            )
          }
        }
      }

      deployed.push(spec.path)
    }

    const warnSuffix = versionWarnings.length ? ` WARNING: ${versionWarnings.join('; ')}.` : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} secret engine(s) to Vault at ${baseUrl}: ${deployed.join(', ')}.${warnSuffix}`,
      artifacts: { baseUrl, deployedMounts: deployed, createdMounts: createdPaths },
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  } catch (error) {
    return {
      success: false,
      message: `Secret engine deployment failed after ${deployed.length} of ${specs.length} mount(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedMounts: deployed, createdMounts: createdPaths },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  }
}

// --- Helpers ---

/**
 * List the cluster's secret engine mounts as the map GET /sys/mounts returns,
 * keyed by "<path>/". Vault echoes the map both at the top level and under a
 * `data` wrapper depending on version — prefer `data` and fall back to the root.
 */
export async function listMounts(client: VaultClient): Promise<Record<string, LiveMount>> {
  const res = await client.request('GET', '/sys/mounts')
  if (!res.ok) {
    throw new Error(`Failed to list secret engine mounts: ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<Record<string, unknown>>(res.body) ?? {}
  const source =
    parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, LiveMount>) : (parsed as Record<string, LiveMount>)
  return source
}

/** Find a mount by its normalized path (null when absent). Vault keys it "<path>/". */
export async function findMount(client: VaultClient, path: string): Promise<LiveMount | null> {
  const mounts = await listMounts(client)
  return mounts[`${path}/`] ?? mounts[path] ?? null
}

/** Read a mount's tuning via GET /sys/mounts/{path}/tune; null on 404. */
export async function getMountTune(client: VaultClient, path: string): Promise<LiveMountTune | null> {
  const res = await client.request('GET', `/sys/mounts/${path}/tune`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read tuning for secret engine "${path}": ${vaultErrorMessage(res)}`)
  }
  const parsed = parseJson<{ data?: LiveMountTune } & LiveMountTune>(res.body)
  return parsed?.data ?? parsed ?? null
}

/** Read `options.version` off a live mount, as a string, or undefined. */
export function readOptionVersion(options: Record<string, unknown> | null | undefined): string | undefined {
  if (!options) return undefined
  const version = options.version
  if (version === undefined || version === null) return undefined
  return String(version)
}

/** Build the POST /sys/mounts/{path} body used to ENABLE a new mount. */
function buildEnableBody(spec: MountSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { type: spec.type }
  if (spec.description !== undefined) body.description = spec.description
  // options.version is enable-only and only meaningful for the kv engine.
  if (spec.type === KV_ENGINE_TYPE && spec.kvVersion) {
    body.options = { version: spec.kvVersion }
  }
  const config = buildTuneConfig(spec)
  if (Object.keys(config).length > 0) body.config = config
  return body
}

/** Build the POST /sys/mounts/{path}/tune body used to CONVERGE an existing mount. */
function buildTuneBody(spec: MountSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { ...buildTuneConfig(spec) }
  // Always send description so clearing it on the canvas converges the mount
  // (and drift detection then agrees about the target state).
  body.description = spec.description ?? ''
  return body
}

/** The tunable lease fields, sent as strings (Vault accepts "768h" or seconds). */
function buildTuneConfig(spec: MountSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  // Only send a TTL the canvas sets — an absent value leaves the system default
  // (or the live value) in place rather than resetting it.
  if (spec.defaultLeaseTtl !== undefined) config.default_lease_ttl = spec.defaultLeaseTtl
  if (spec.maxLeaseTtl !== undefined) config.max_lease_ttl = spec.maxLeaseTtl
  return config
}
