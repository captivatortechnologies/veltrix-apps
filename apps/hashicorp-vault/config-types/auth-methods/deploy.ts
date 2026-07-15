import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import {
  extractAuthMethodSpecs,
  type AuthMethodSpec,
  type LiveAuthMethod,
  type LiveAuthTune,
} from './validate'

export interface AuthMethodRollbackEntry {
  path: string
  type: string
  /** true = the mount already existed and was TUNED; false = deploy ENABLED it. */
  existed: boolean
  /** Prior tuning captured before a tune, so rollback can restore it. */
  priorTune?: LiveAuthTune
}

/**
 * Deploy auth-method mounts to a Vault cluster via the sys/auth API.
 *
 * An auth method is enabled at a PATH; its TYPE is fixed at enable time and can
 * never change in place. For each declared method (three-branch decision tree):
 *   1. path ABSENT               → POST /sys/auth/{path}          (enable; capture in createdPaths)
 *   2. path PRESENT, SAME type   → POST /sys/auth/{path}/tune     (converge tunables; capture prior tune)
 *   3. path PRESENT, DIFFERENT   → FAIL — the type is immutable. We do NOT disable+re-enable,
 *                                  because that revokes every lease/token under the mount. The
 *                                  operator must remove the mount manually to replace its type.
 *
 * Identity is the PATH (matched against the `"<path>/"` keys in GET /sys/auth).
 * validate refuses the protected built-in `token/` method and dedupes on path.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAuthMethodSpecs(ctx.canvas).filter((s) => s.path && s.type)
  const rollbackState: AuthMethodRollbackEntry[] = []
  const createdPaths: string[] = []
  const deployed: string[] = []

  try {
    // One list resolves every path's existence and current type.
    const existing = await listAuthMethods(client)

    for (const spec of specs) {
      const live = existing[authKey(spec.path)]

      if (!live) {
        // 1. ABSENT → enable at this path.
        const res = await client.request('POST', `/sys/auth/${spec.path}`, {
          body: buildEnableBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to enable auth method "${spec.path}" (type ${spec.type}): ${vaultErrorMessage(res)}`)
        }
        rollbackState.push({ path: spec.path, type: spec.type, existed: false })
        createdPaths.push(spec.path)

        // token_type is tune-only — Vault does not accept it in the enable body's
        // config, so a new mount that wants a non-default token_type must be
        // tuned right after enabling, or the setting is silently dropped.
        if (spec.tokenType) {
          const tuneRes = await client.request('POST', `/sys/auth/${spec.path}/tune`, {
            body: { token_type: spec.tokenType },
          })
          if (!tuneRes.ok) {
            throw new Error(
              `Enabled auth method "${spec.path}" but failed to set token_type=${spec.tokenType}: ${vaultErrorMessage(tuneRes)}`,
            )
          }
        }
        deployed.push(`${spec.path} (enabled ${spec.type})`)
      } else if ((live.type ?? '') === spec.type) {
        // 2. PRESENT, SAME type → converge tunables via tune (never re-enable).
        // Capture prior tuning FIRST so a rollback can restore it.
        const priorTune = await readAuthTune(client, spec.path)
        rollbackState.push({
          path: spec.path,
          type: spec.type,
          existed: true,
          priorTune: priorTune ?? undefined,
        })

        const res = await client.request('POST', `/sys/auth/${spec.path}/tune`, {
          body: buildTuneBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to tune auth method "${spec.path}": ${vaultErrorMessage(res)}`)
        }
        deployed.push(`${spec.path} (tuned)`)
      } else {
        // 3. PRESENT, DIFFERENT type → FAIL. Type is immutable; we refuse to
        // disable+re-enable because that is destructive (revokes leases/tokens).
        throw new Error(
          `Auth method "${spec.path}" is already enabled with type "${live.type}", but the ` +
            `configuration declares type "${spec.type}". An auth method's type is IMMUTABLE and ` +
            `cannot be changed in place. This app will not disable and re-enable the mount to ` +
            `switch its type, because that revokes every lease and token issued under it. To ` +
            `replace it, remove the mount manually first (vault auth disable ${spec.path}), then ` +
            `re-run this deployment.`,
        )
      }
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} auth method(s) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedAuthMethods: deployed },
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth method deployment failed after ${deployed.length} of ${specs.length} method(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAuthMethods: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  }
}

// --- Helpers ---

/** The `GET /sys/auth` map is keyed by the path WITH a trailing slash. */
export function authKey(path: string): string {
  return `${path}/`
}

/**
 * List enabled auth methods: `GET /sys/auth` → a map keyed by `"userpass/"`.
 * Returns the `data` map (the documented, authenticated shape).
 */
export async function listAuthMethods(client: VaultClient): Promise<Record<string, LiveAuthMethod>> {
  const res = await client.request('GET', '/sys/auth')
  if (!res.ok) {
    throw new Error(`Failed to list auth methods: ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: Record<string, LiveAuthMethod> }>(res.body)?.data ?? {}
}

/** Read a mount's tuning: `GET /sys/auth/{path}/tune` → `data`; null on 404. */
export async function readAuthTune(client: VaultClient, path: string): Promise<LiveAuthTune | null> {
  const res = await client.request('GET', `/sys/auth/${path}/tune`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read tuning for auth method "${path}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveAuthTune }>(res.body)?.data ?? null
}

/**
 * Body for `POST /sys/auth/{path}` (enable). The tunables ride in a nested
 * `config` object at enable time; TTLs are sent as strings (Vault accepts
 * "768h" as well as a seconds count).
 */
function buildEnableBody(spec: AuthMethodSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (spec.defaultLeaseTtl) config.default_lease_ttl = spec.defaultLeaseTtl
  if (spec.maxLeaseTtl) config.max_lease_ttl = spec.maxLeaseTtl
  if (spec.listingVisibility) config.listing_visibility = spec.listingVisibility
  // token_type is deliberately NOT set here — it is tune-only (Vault rejects/ignores
  // it in the enable config), so deploy applies it via a follow-up tune call.

  const body: Record<string, unknown> = { type: spec.type }
  if (spec.description) body.description = spec.description
  if (Object.keys(config).length > 0) body.config = config
  return body
}

/**
 * Body for `POST /sys/auth/{path}/tune` (converge). Tune fields are FLAT (not
 * nested in `config`). Description is always sent so clearing it on the canvas
 * converges the live mount; the TTL/visibility/token fields are only sent when
 * the canvas sets them, so an unset field leaves Vault's current value alone.
 */
function buildTuneBody(spec: AuthMethodSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { description: spec.description ?? '' }
  if (spec.defaultLeaseTtl) body.default_lease_ttl = spec.defaultLeaseTtl
  if (spec.maxLeaseTtl) body.max_lease_ttl = spec.maxLeaseTtl
  if (spec.listingVisibility) body.listing_visibility = spec.listingVisibility
  if (spec.tokenType) body.token_type = spec.tokenType
  return body
}
