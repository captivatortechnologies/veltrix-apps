import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import {
  extractCredentialSpecs,
  parseSettingsObject,
  type CredentialSpec,
  type LiveCredential,
} from './validate'

export interface CredentialRollbackEntry {
  name: string
  existed: boolean
  uuid?: string
  /**
   * Prior NON-SECRET fields, captured for rollback of an updated credential.
   * NOTE: there is no `settings` here on purpose — the secret settings are
   * write-only and Tenable never returns them, so a prior value cannot be
   * captured and rollback cannot restore the previous secrets (see rollback.ts).
   */
  prior?: Partial<Pick<LiveCredential, 'name' | 'description' | 'type'>>
}

/**
 * Deploy managed credentials to a Tenable tenant via the Credentials API.
 *
 * A credential is a named, typed secret bundle. Its logical identity is the
 * NAME; the UUID Tenable assigns is the stable key used for rollback. For each
 * declared credential:
 *   - GET  /credentials          — list, then match on `name`
 *   - PUT  /credentials/{uuid}    — update an existing credential (capture the
 *                                   prior NON-SECRET body for rollback)
 *   - POST /credentials          — create a missing credential (capture new uuid)
 *
 * SECRET-BEARING: the per-type `settings` object holds write-only secrets. They
 * are pushed on every deploy (create AND update) because they can never be read
 * back to compare — so config-as-code always re-asserts them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCredentialSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: CredentialRollbackEntry[] = []
  const createdUuids: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.name

      // Settings are validated upstream; re-parse here to build the API body and
      // to fail loudly rather than send malformed settings.
      const settings = spec.settingsJson ? parseSettingsObject(spec.settingsJson) : null
      if (!settings) {
        throw new Error(`Credential "${label}": settings are not a valid JSON object`)
      }

      const existing = await findCredentialByName(client, spec.name)

      if (existing && existing.uuid) {
        // Capture only the NON-SECRET prior fields — the secret settings cannot
        // be read back, so rollback can restore name/description/type but never
        // the previous secrets.
        rollbackState.push({
          name: spec.name,
          existed: true,
          uuid: existing.uuid,
          prior: {
            name: existing.name,
            // Explicit empty so rollback can clear a description this deploy set
            // on a credential that previously had none.
            description: existing.description ?? '',
            type: existing.type,
          },
        })

        const res = await client.request('PUT', `/credentials/${existing.uuid}`, {
          body: buildUpdatePayload(spec, settings),
        })
        if (!res.ok) {
          throw new Error(`Failed to update credential "${label}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/credentials', {
          body: buildCreatePayload(spec, settings),
        })
        if (!res.ok) {
          throw new Error(`Failed to create credential "${label}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveCredential>(res.body)
        if (!created?.uuid) {
          throw new Error(`Credential "${label}" was created but the API returned no uuid`)
        }
        rollbackState.push({ name: spec.name, existed: false, uuid: created.uuid })
        createdUuids.push(created.uuid)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} credential(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedCredentials: deployed },
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  } catch (error) {
    return {
      success: false,
      message: `Credential deployment failed after ${deployed.length} of ${specs.length} credential(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedCredentials: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  }
}

// --- Helpers ---

/**
 * Find a credential by its `name`; null when absent.
 * GET /credentials returns the full credential list (metadata only — no secret
 * settings). Matched exactly (case-sensitive) so it agrees with validate's
 * name dedupe and never adopts a same-named-but-different-case credential.
 */
export async function findCredentialByName(
  client: TenableClient,
  name: string,
): Promise<LiveCredential | null> {
  const res = await client.request('GET', '/credentials')
  if (!res.ok) {
    throw new Error(`Failed to list credentials while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const credentials = parseJson<{ credentials?: LiveCredential[] }>(res.body)?.credentials ?? []
  return credentials.find((c) => c.name === name) ?? null
}

/**
 * Fetch a single credential by uuid; null on 404. NOTE: the returned body still
 * omits the write-only secret settings — this only confirms existence and reads
 * back the non-secret metadata.
 */
export async function getCredentialByUuid(
  client: TenableClient,
  uuid: string,
): Promise<LiveCredential | null> {
  const res = await client.request('GET', `/credentials/${uuid}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch credential ${uuid}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LiveCredential>(res.body)
}

function buildCreatePayload(
  spec: CredentialSpec,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  // POST /credentials body: name + type + per-type settings. `type` is a slug
  // (e.g. "SSH"); `settings` carries the write-only secrets.
  const payload: Record<string, unknown> = {
    name: spec.name,
    type: spec.type,
    settings,
  }
  if (spec.description) payload.description = spec.description
  return payload
}

function buildUpdatePayload(
  spec: CredentialSpec,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  // description is always sent so clearing it on the canvas converges the live
  // credential. settings is always re-sent because the secrets are write-only
  // and cannot be compared — the canvas is the source of truth.
  return {
    name: spec.name,
    type: spec.type,
    description: spec.description ?? '',
    settings,
  }
}
