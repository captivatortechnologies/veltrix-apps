import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import { extractPkiRoleSpecs, roleKey, type LivePkiRole, type PkiRoleSpec } from './validate'

export interface PkiRoleRollbackEntry {
  mount: string
  name: string
  /** false = deploy CREATED this role (rollback DELETES it). */
  existed: boolean
  /**
   * The COMPLETE prior role object captured before an update (verbatim from
   * GET), so rollback can restore it exactly. Not modeled field-by-field — see
   * LivePkiRole — because a role write is a FULL REPLACE (see deploy() below),
   * so only re-sending everything Vault had reproduces the prior role exactly.
   */
  priorBody?: LivePkiRole
}

/**
 * Deploy Vault PKI role definitions via `{mount}/roles/{name}`.
 *
 * `POST {mount}/roles/{name}` is a TRUE UPSERT and, unlike `/sys/mounts/.../tune`
 * or `/sys/auth/.../tune`, it is NOT a partial merge: Vault's role write is not
 * documented to preserve an existing role's unspecified fields, and in practice
 * (mirroring every other Vault secrets-engine "role" object — database, AWS,
 * SSH) writing a role re-applies the FULL schema, defaulting anything this
 * canvas does not set. Adopting an existing role into this config type
 * therefore takes full ownership of it: a field a human set out-of-band that
 * this canvas does not model will revert to Vault's built-in default on the
 * very first deploy. This is called out in the README.
 *
 * Because of that full-replace behavior, rollback of an UPDATED role needs the
 * complete prior role object (every field Vault had), not just the subset this
 * canvas manages — deploy captures it verbatim via GET before writing.
 *
 * The role's identity is the composite (mount, name); mount is the PKI engine's
 * mount path (managed separately by the secret-mounts config type — this
 * config type does not create or verify the mount, it only writes roles under
 * whatever mount is declared).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPkiRoleSpecs(ctx.canvas).filter((s) => s.mount && s.name)
  const rollbackState: PkiRoleRollbackEntry[] = []
  const createdKeys: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const key = roleKey(spec.mount, spec.name)
      const live = await getPkiRole(client, spec.mount, spec.name)

      if (!live) {
        rollbackState.push({ mount: spec.mount, name: spec.name, existed: false })
        createdKeys.push(key)
      } else {
        // Capture the COMPLETE prior role (verbatim) — see the file header on
        // why a subset is not enough to restore an updated role exactly.
        rollbackState.push({ mount: spec.mount, name: spec.name, existed: true, priorBody: live })
      }

      const res = await client.request('POST', `/${spec.mount}/roles/${spec.name}`, {
        body: buildRoleBody(spec),
      })
      if (!res.ok) {
        throw new Error(`Failed to write PKI role "${key}": ${vaultErrorMessage(res)}`)
      }

      deployed.push(key)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} PKI role(s) to Vault at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRoles: deployed, createdRoles: createdKeys },
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  } catch (error) {
    return {
      success: false,
      message: `PKI role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRoles: deployed, createdRoles: createdKeys },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  }
}

// --- Helpers ---

/** Read one role: GET {mount}/roles/{name} → `data`. Returns null on 404 (absent). */
export async function getPkiRole(client: VaultClient, mount: string, name: string): Promise<LivePkiRole | null> {
  const res = await client.request('GET', `/${mount}/roles/${name}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read PKI role "${roleKey(mount, name)}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LivePkiRole }>(res.body)?.data ?? null
}

/**
 * Build the POST {mount}/roles/{name} body. Booleans and list fields are
 * ALWAYS sent (a coerced boolean always has a value, and an empty list clears
 * the role's list to empty) so the canvas stays the full source of truth for
 * every field it models. Optional scalars (ttl, key_type, ...) are sent only
 * when authored — omitting them lands on Vault's own documented default for
 * that field, which is the desired "not managed here" behavior.
 */
function buildRoleBody(spec: PkiRoleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    key_usage: spec.keyUsage,
    allowed_domains: spec.allowedDomains,
    allow_bare_domains: spec.allowBareDomains,
    allow_subdomains: spec.allowSubdomains,
    allow_glob_domains: spec.allowGlobDomains,
    allow_wildcard_certificates: spec.allowWildcardCertificates,
    allow_localhost: spec.allowLocalhost,
    allow_any_name: spec.allowAnyName,
    enforce_hostnames: spec.enforceHostnames,
    allow_ip_sans: spec.allowIpSans,
    server_flag: spec.serverFlag,
    client_flag: spec.clientFlag,
    code_signing_flag: spec.codeSigningFlag,
    require_cn: spec.requireCn,
    use_csr_common_name: spec.useCsrCommonName,
    no_store: spec.noStore,
    generate_lease: spec.generateLease,
  }
  if (spec.ttl !== undefined) body.ttl = spec.ttl
  if (spec.maxTtl !== undefined) body.max_ttl = spec.maxTtl
  if (spec.keyType !== undefined) body.key_type = spec.keyType
  if (spec.keyBits !== undefined) body.key_bits = spec.keyBits
  if (spec.notBeforeDuration !== undefined) body.not_before_duration = spec.notBeforeDuration
  if (spec.issuerRef !== undefined) body.issuer_ref = spec.issuerRef
  return body
}
