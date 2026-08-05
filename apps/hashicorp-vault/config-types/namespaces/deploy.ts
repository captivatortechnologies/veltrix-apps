import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import { extractNamespaceSpecs, resolveMetadata, type LiveNamespace, type NamespaceSpec } from './validate'

export interface NamespaceRollbackEntry {
  path: string
  /** false = deploy CREATED this namespace (rollback DESTROYS it — see rollback.ts). */
  existed: boolean
  /** Prior custom_metadata captured before deploy patched an existing namespace. */
  priorCustomMetadata?: Record<string, string>
}

/**
 * Deploy Vault namespaces via `/sys/namespaces/{path}` (Enterprise only).
 * `POST` creates a namespace; converging an EXISTING namespace's
 * custom_metadata requires `PATCH` (a real RFC 7396 JSON MERGE PATCH — see
 * lib/vault.ts), not POST, per Vault's documented namespace API. For each
 * declared namespace:
 *
 *   1. path ABSENT  → POST /sys/namespaces/{path}   (create; captured in
 *      createdPaths). custom_metadata can be set directly on create.
 *   2. path PRESENT → PATCH /sys/namespaces/{path}   (converge custom_metadata
 *      to exactly what the canvas declares — see buildMetadataPatch, which
 *      explicitly nulls out any prior key the canvas no longer sets, since a
 *      merge patch otherwise LEAVES untouched keys in place).
 *
 * Namespace management calls run in whatever namespace context the app's
 * `namespace` setting specifies (blank = root) — see the README.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractNamespaceSpecs(ctx.canvas).filter((s) => s.path)
  const rollbackState: NamespaceRollbackEntry[] = []
  const createdPaths: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const live = await getNamespace(client, spec.path)

      if (!live) {
        const res = await client.request('POST', `/sys/namespaces/${spec.path}`, {
          body: buildCreateBody(spec),
        })
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error(
              `Failed to create namespace "${spec.path}": namespaces are a Vault Enterprise feature and this ` +
                `cluster returned 404 — confirm the cluster is running Vault Enterprise (${vaultErrorMessage(res)})`,
            )
          }
          throw new Error(`Failed to create namespace "${spec.path}": ${vaultErrorMessage(res)}`)
        }
        rollbackState.push({ path: spec.path, existed: false })
        createdPaths.push(spec.path)
        deployed.push(`${spec.path} (created)`)
      } else {
        const priorMetadata = live.custom_metadata ?? {}
        rollbackState.push({ path: spec.path, existed: true, priorCustomMetadata: priorMetadata })

        const desiredMetadata = resolveMetadata(spec.customMetadataJson)
        const patch = buildMetadataPatch(desiredMetadata, priorMetadata)
        if (Object.keys(patch).length > 0) {
          const res = await client.request('PATCH', `/sys/namespaces/${spec.path}`, {
            body: { custom_metadata: patch },
          })
          if (!res.ok) {
            throw new Error(`Failed to update namespace "${spec.path}": ${vaultErrorMessage(res)}`)
          }
        }
        deployed.push(`${spec.path} (updated)`)
      }
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} namespace(s) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedNamespaces: deployed, createdNamespaces: createdPaths },
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  } catch (error) {
    return {
      success: false,
      message: `Namespace deployment failed after ${deployed.length} of ${specs.length} namespace(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedNamespaces: deployed, createdNamespaces: createdPaths },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPaths },
    }
  }
}

// --- Helpers ---

/** Read one namespace: GET /sys/namespaces/{path} → `data`. Returns null on 404 (absent). */
export async function getNamespace(client: VaultClient, path: string): Promise<LiveNamespace | null> {
  const res = await client.request('GET', `/sys/namespaces/${path}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read namespace "${path}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveNamespace }>(res.body)?.data ?? null
}

/** Build the POST /sys/namespaces/{path} body used to CREATE a namespace. */
function buildCreateBody(spec: NamespaceSpec): Record<string, unknown> {
  const metadata = resolveMetadata(spec.customMetadataJson)
  return Object.keys(metadata).length > 0 ? { custom_metadata: metadata } : {}
}

/**
 * Build the `custom_metadata` object for a PATCH body so the canvas fully
 * converges the namespace's metadata — a JSON MERGE PATCH (RFC 7396) only ADDS
 * or REPLACES keys present in the patch and LEAVES every other key untouched,
 * so a key the canvas no longer declares must be explicitly set to `null`
 * (RFC 7396's delete signal) or it would linger forever.
 */
export function buildMetadataPatch(
  desired: Record<string, string>,
  prior: Record<string, string>,
): Record<string, string | null> {
  const patch: Record<string, string | null> = { ...desired }
  for (const key of Object.keys(prior)) {
    if (!(key in desired)) patch[key] = null
  }
  return patch
}
