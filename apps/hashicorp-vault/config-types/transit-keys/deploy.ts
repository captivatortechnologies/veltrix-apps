import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, parseJson, vaultErrorMessage, type VaultClient } from '../../lib/vault'
import { extractTransitKeySpecs, keyKey, type LiveTransitKey, type TransitKeySpec } from './validate'

export interface TransitKeyRollbackEntry {
  mount: string
  name: string
  /** false = deploy CREATED this key (rollback DESTROYS it — see rollback.ts). */
  existed: boolean
  /** Prior TUNABLE config captured before deploy tuned an existing key (update branch). */
  priorConfig?: {
    deletion_allowed?: boolean
    min_decryption_version?: number
    min_encryption_version?: number
    auto_rotate_period?: number
  }
}

/**
 * Deploy Vault Transit key CONFIGURATION via `{mount}/keys/{name}` (create) and
 * `{mount}/keys/{name}/config` (tune). A transit key is CREATE-ONLY for its
 * cryptographic shape: `type`, `convergent_encryption`, `derived` and `key_size`
 * are fixed when the key is created and are IMMUTABLE thereafter (Vault
 * generates the key material itself; there is no way to change these in place
 * without generating a brand-new key, which would be a DIFFERENT key, not a
 * configuration change). For each declared key, the same three-branch decision
 * tree as secret-mounts / auth-methods applies:
 *
 *   1. (mount,name) ABSENT       → POST {mount}/keys/{name}            (create;
 *      captured in createdKeys), ALWAYS followed by a config tune — the
 *      create endpoint does not accept deletion_allowed or the version
 *      bounds, so those (and any other declared tunable) are applied right
 *      after creation.
 *   2. PRESENT, SAME type        → POST {mount}/keys/{name}/config     (converge
 *      the tunables; prior tune captured for rollback)
 *   3. PRESENT, DIFFERENT type   → FAIL. `type` cannot change in place, and
 *      this app will not delete + recreate a key under the same name: that
 *      would mint an entirely NEW key with NEW material, permanently losing
 *      every prior key version's ability to decrypt (min_decryption_version
 *      history, convergent-encryption determinism, everything).
 *
 * `exportable` and `allow_plaintext_backup` are WRITE-ONCE in Vault (once true,
 * Vault will not let them go back to false) — the tune body only ever sends
 * `true` for these (escalating), never `false`; if the canvas wants `false` but
 * the live key is already `true`, that is UNFIXABLE by a redeploy and is
 * surfaced as a warning (see driftDetect.ts, which flags it the same way).
 *
 * This handler never reads, writes, or logs the key's actual byte material —
 * Vault does not return it, and this app has no operation that would.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractTransitKeySpecs(ctx.canvas).filter((s) => s.mount && s.name && s.type)
  const rollbackState: TransitKeyRollbackEntry[] = []
  const createdKeys: string[] = []
  const deployed: string[] = []
  const unfixableWarnings: string[] = []

  try {
    for (const spec of specs) {
      const key = keyKey(spec.mount, spec.name)
      const live = await getTransitKey(client, spec.mount, spec.name)

      if (!live) {
        // Branch 1 — absent → create. exportable/allow_plaintext_backup/
        // auto_rotate_period CAN be set at create time; deletion_allowed and the
        // version bounds cannot, so a follow-up config tune applies those.
        const res = await client.request('POST', `/${spec.mount}/keys/${spec.name}`, {
          body: buildCreateBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create transit key "${key}": ${vaultErrorMessage(res)}`)
        }
        rollbackState.push({ mount: spec.mount, name: spec.name, existed: false })
        createdKeys.push(key)

        const followUp = buildConfigBody(spec, { liveExportable: spec.exportable, liveAllowBackup: spec.allowPlaintextBackup })
        if (Object.keys(followUp).length > 0) {
          const tuneRes = await client.request('POST', `/${spec.mount}/keys/${spec.name}/config`, { body: followUp })
          if (!tuneRes.ok) {
            throw new Error(`Created transit key "${key}" but failed to apply its configuration: ${vaultErrorMessage(tuneRes)}`)
          }
        }
        deployed.push(`${key} (created)`)
      } else if ((live.type ?? '').toLowerCase() === spec.type) {
        // Branch 2 — present, same type → converge tunables via config. Capture
        // the prior tune first so rollback can restore it.
        rollbackState.push({
          mount: spec.mount,
          name: spec.name,
          existed: true,
          priorConfig: {
            deletion_allowed: live.deletion_allowed,
            min_decryption_version: live.min_decryption_version,
            min_encryption_version: live.min_encryption_version,
            auto_rotate_period: live.auto_rotate_period,
          },
        })

        const liveExportable = live.exportable === true
        const liveAllowBackup = live.allow_plaintext_backup === true
        const body = buildConfigBody(spec, { liveExportable, liveAllowBackup })
        if (Object.keys(body).length > 0) {
          const res = await client.request('POST', `/${spec.mount}/keys/${spec.name}/config`, { body })
          if (!res.ok) {
            throw new Error(`Failed to configure transit key "${key}": ${vaultErrorMessage(res)}`)
          }
        }

        // exportable / allow_plaintext_backup are write-once — flag an
        // unfixable downgrade rather than silently doing nothing about it.
        if (!spec.exportable && liveExportable) {
          unfixableWarnings.push(`key "${key}" is exportable=true and cannot be reverted to false (write-once)`)
        }
        if (!spec.allowPlaintextBackup && liveAllowBackup) {
          unfixableWarnings.push(`key "${key}" is allow_plaintext_backup=true and cannot be reverted to false (write-once)`)
        }

        deployed.push(`${key} (configured)`)
      } else {
        // Branch 3 — present, DIFFERENT type → FAIL. Never delete + recreate: a
        // new key under the same name has NEW material, unrelated to the old one.
        throw new Error(
          `Transit key "${key}" already exists with type "${live.type}", but the configuration requests type ` +
            `"${spec.type}". A transit key's type is immutable and Vault generates its key material internally — ` +
            `there is no in-place conversion. This app will not delete and recreate the key under the same name, ` +
            `because that would mint an entirely new key, permanently losing the ability to decrypt anything ` +
            `encrypted under the old one. Rotate to a differently-named key, or remove the existing key manually ` +
            `(and understand the data-loss implications) if you truly intend to replace it.`,
        )
      }
    }

    const warnSuffix = unfixableWarnings.length ? ` WARNING: ${unfixableWarnings.join('; ')}.` : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} transit key(s) to Vault at ${baseUrl}: ${deployed.join(', ')}.${warnSuffix}`,
      artifacts: { baseUrl, deployedKeys: deployed, createdKeys },
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  } catch (error) {
    return {
      success: false,
      message: `Transit key deployment failed after ${deployed.length} of ${specs.length} key(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedKeys: deployed, createdKeys },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdKeys },
    }
  }
}

// --- Helpers ---

/** Read one key: GET {mount}/keys/{name} → `data`. Returns null on 404 (absent). */
export async function getTransitKey(client: VaultClient, mount: string, name: string): Promise<LiveTransitKey | null> {
  const res = await client.request('GET', `/${mount}/keys/${name}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read transit key "${keyKey(mount, name)}": ${vaultErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveTransitKey }>(res.body)?.data ?? null
}

/** Build the POST {mount}/keys/{name} body used to CREATE a new key. */
function buildCreateBody(spec: TransitKeySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: spec.type,
    convergent_encryption: spec.convergentEncryption,
    derived: spec.derived,
  }
  if (spec.keySize !== undefined) body.key_size = spec.keySize
  // exportable / allow_plaintext_backup can be set at create time; only send
  // `true` — Vault's default is already false, so there is nothing to "send false" for.
  if (spec.exportable) body.exportable = true
  if (spec.allowPlaintextBackup) body.allow_plaintext_backup = true
  if (spec.autoRotatePeriod !== undefined) body.auto_rotate_period = spec.autoRotatePeriod
  return body
}

/**
 * Build the POST {mount}/keys/{name}/config body used to CONVERGE an existing
 * key's tunables. `exportable` / `allow_plaintext_backup` are WRITE-ONCE in
 * Vault — this only ever sends `true` for them (never `false`, which Vault
 * would reject or ignore once they are already true); a live `true` that the
 * canvas wants reverted to `false` is surfaced by the caller as an unfixable
 * warning instead.
 */
function buildConfigBody(
  spec: TransitKeySpec,
  live: { liveExportable: boolean; liveAllowBackup: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deletion_allowed: spec.deletionAllowed,
  }
  if (spec.minDecryptionVersion !== undefined) body.min_decryption_version = spec.minDecryptionVersion
  if (spec.minEncryptionVersion !== undefined) body.min_encryption_version = spec.minEncryptionVersion
  if (spec.autoRotatePeriod !== undefined) body.auto_rotate_period = spec.autoRotatePeriod
  if (spec.exportable && !live.liveExportable) body.exportable = true
  if (spec.allowPlaintextBackup && !live.liveAllowBackup) body.allow_plaintext_backup = true
  return body
}
