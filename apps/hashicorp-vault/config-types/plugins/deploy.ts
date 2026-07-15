import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import {
  extractPluginSpecs,
  parseStringArray,
  pluginKey,
  type LivePlugin,
  type PluginSpec,
} from './validate'

export interface PluginRollbackEntry {
  type: string
  name: string
  /** false = deploy REGISTERED this plugin (rollback deregisters it). */
  existed: boolean
  /**
   * Prior registration captured before deploy UPDATED an existing external
   * plugin, so rollback can re-register it. `env` is never captured — Vault does
   * not return it on GET — so a restore cannot reinstate a prior env.
   */
  prior?: {
    sha256?: string
    command?: string
    args?: string[]
    version?: string
  }
}

/**
 * Register EXTERNAL plugins in the Vault catalog via
 * /sys/plugins/catalog/{type}/{name} (a sudo path). Registration is metadata
 * only: the binary itself must already be staged in the cluster's
 * plugin_directory and match the declared sha256 — deploy never uploads a
 * binary. The name-in-path write is an UPSERT, so for each declared plugin:
 *
 *   1. GET the catalog entry.
 *   2. builtin: true  → FAIL. This app manages EXTERNAL plugins ONLY and refuses
 *      to register/update over a Vault built-in of the same (type, name).
 *   3. ABSENT (404)   → POST to register it (captured in createdPlugins).
 *   4. PRESENT (external) → capture the prior registration, then POST to update.
 *
 * The register body is:
 *   POST /sys/plugins/catalog/{type}/{name}
 *   { "sha256": <hex>, "command": <exe>, "args": [...], "version": <semver?>, "env": [...] }
 * `args` is always sent (so clearing it on the canvas converges the entry);
 * `env` is sent only when authored — it may hold secrets and is never read back.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPluginSpecs(ctx.canvas).filter((s) => s.type && s.name && s.sha256 && s.command)
  const rollbackState: PluginRollbackEntry[] = []
  const createdPlugins: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const key = pluginKey(spec.type, spec.name)
      const live = await getPlugin(client, spec.type, spec.name)

      // Guard: external-only. A live entry that is builtin must never be touched
      // — registering/updating over it would shadow or mutate a Vault built-in.
      if (live && live.builtin === true) {
        throw new Error(
          `Refusing to register plugin "${key}": a BUILT-IN Vault plugin already exists under that name. ` +
            `This app manages EXTERNAL plugins only and will not register, update, or delete a built-in. ` +
            `Choose a different name for your external plugin.`,
        )
      }

      if (!live) {
        // ABSENT → register. Capture in createdPlugins so rollback deregisters it.
        const res = await client.request('POST', `/sys/plugins/catalog/${spec.type}/${spec.name}`, {
          body: buildRegisterBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to register plugin "${key}": ${vaultErrorMessage(res)}`)
        }
        rollbackState.push({ type: spec.type, name: spec.name, existed: false })
        createdPlugins.push(key)
        deployed.push(`${key} (registered)`)
      } else {
        // PRESENT external → update. Capture the prior registration FIRST so a
        // rollback can re-register it (env cannot be captured — see the entry).
        rollbackState.push({
          type: spec.type,
          name: spec.name,
          existed: true,
          prior: {
            sha256: typeof live.sha256 === 'string' ? live.sha256 : undefined,
            command: typeof live.command === 'string' ? live.command : undefined,
            args: Array.isArray(live.args) ? live.args : undefined,
            version: typeof live.version === 'string' ? live.version : undefined,
          },
        })

        const res = await client.request('POST', `/sys/plugins/catalog/${spec.type}/${spec.name}`, {
          body: buildRegisterBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update plugin "${key}": ${vaultErrorMessage(res)}`)
        }
        deployed.push(`${key} (updated)`)
      }
    }

    return {
      success: true,
      message: `Registered ${deployed.length} external plugin(s) in the Vault catalog at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPlugins: deployed, createdPlugins },
      rollbackData: { previousState: rollbackState, createdPlugins },
    }
  } catch (error) {
    return {
      success: false,
      message: `Plugin registration failed after ${deployed.length} of ${specs.length} plugin(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPlugins: deployed, createdPlugins },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPlugins },
    }
  }
}

// --- Helpers ---

/**
 * Read one catalog entry: GET /sys/plugins/catalog/{type}/{name} → `data`.
 * Returns null on 404 (the plugin is absent). The `builtin` flag on the returned
 * entry is what the deploy guard keys on.
 */
export async function getPlugin(
  client: VaultClient,
  type: string,
  name: string,
): Promise<LivePlugin | null> {
  const res = await client.request('GET', `/sys/plugins/catalog/${type}/${name}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read plugin "${pluginKey(type, name)}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LivePlugin }>(res.body)?.data ?? null
}

/**
 * Build the POST /sys/plugins/catalog/{type}/{name} body. `sha256` and `command`
 * are always present (validate guarantees them). `args` is always sent — an
 * empty array clears any prior args so the canvas stays the source of truth.
 * `version` and `env` are sent only when authored; `env` may hold secrets and is
 * never read back, so it is set on write but never cleared implicitly.
 */
function buildRegisterBody(spec: PluginSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sha256: spec.sha256,
    command: spec.command,
    args: spec.argsJson ? parseStringArray(spec.argsJson) ?? [] : [],
  }
  if (spec.version) body.version = spec.version
  const env = spec.envJson ? parseStringArray(spec.envJson) : null
  if (env && env.length > 0) body.env = env
  return body
}
