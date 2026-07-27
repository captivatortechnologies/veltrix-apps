import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, parseEnvelope, type FalconClient } from '../../lib/falcon'
import { findEntityByIdentity, type EntityEndpoints } from '../../lib/entityAdapter'
import { extractPutFileSpecs, type LiveRtrPutFile, type PutFileSpec } from './validate'

// =============================================================================
// ⚠️  MULTIPART + IMMUTABILITY CAVEATS — READ BEFORE PRODUCTION USE ⚠️
//
// 1. MULTIPART: The Falcon Real Time Response Admin API models put-file CREATE
//    as **multipart/form-data (file upload)** — and ONLY that. Verified against
//    FalconPy `real_time_response_admin`:
//      RTR-CreatePut-Files (POST /real-time-response/entities/put-files/v1)
//        — consumes: multipart/form-data; the file body is the required `file`
//          part (there is NOT even an inline `content` field, unlike scripts).
//    The shared FalconClient (lib/falcon.ts) sends ONLY application/json and is
//    FORBIDDEN to edit from this config type. So createPutFile builds the
//    correct fields but sends them as a JSON body — Falcon will reject this
//    until lib/falcon.ts sends the content as a multipart `file` part. When it
//    does, only the transport in createPutFile changes.
//
// 2. IMMUTABILITY: put-files have NO PATCH — they cannot be edited in place. To
//    change one, it must be deleted and recreated. GET also never returns the
//    stored bytes (only a `sha256`), so:
//      - Deploy is idempotent: an existing put-file whose live `sha256` already
//        matches the declared content is left untouched (no destructive churn).
//      - A content change is converged by delete-then-recreate.
//      - ROLLBACK of a replaced put-file can delete the new file but CANNOT
//        restore the original bytes (the API never exposes them) — this is
//        surfaced in the rollback message.
//
// Everything else works TODAY over JSON + query params: find-by-name (query +
// get), delete, health check, and drift detection.
// =============================================================================

const MULTIPART_HINT =
  '(RTR put-file create requires the content as a multipart/form-data `file` part — add multipart support to lib/falcon.ts)'

const DEPLOY_AUDIT_COMMENT = 'Managed by Veltrix (crowdstrike-edr app)'

/** Query/get/create/delete paths + identity field for RTR put-files. */
export const PUT_FILE_ENDPOINTS: EntityEndpoints = {
  entity: '/real-time-response/entities/put-files/v1',
  queries: '/real-time-response/queries/put-files/v1',
  identityField: 'name',
}

/** Put-file state captured during deploy so rollback can reverse it. */
export interface PutFileRollbackEntry {
  name: string
  existed: boolean
  /** The put-file id this deploy created, or the existing id left untouched. */
  id?: string
  /** True when deploy delete+recreated a pre-existing put-file. */
  replaced?: boolean
  /** Description of the replaced original (metadata only — its bytes are unrecoverable). */
  priorDescription?: string
}

/**
 * Deploy RTR put-files to a Falcon tenant.
 *
 * For each declared put-file:
 *   - find it by name (query → get, JSON)
 *   - create it when missing (multipart, see caveat)
 *   - when it exists and its content changed (sha256 mismatch), delete + recreate
 *   - when it exists and content matches, leave it untouched (idempotent)
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPutFileSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PutFileRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findPutFile(client, spec.name)

      if (existing?.id) {
        const unchanged = await contentMatches(spec.content, existing.sha256)
        if (unchanged) {
          // Idempotent: live bytes already match — do not delete/recreate.
          rollbackState.push({ name: spec.name, existed: true, id: existing.id, replaced: false })
        } else {
          // Immutable: converge by delete-then-recreate. The original bytes are
          // not retrievable, so rollback of this cannot restore them (documented).
          await deletePutFile(client, existing.id)
          const newId = await createPutFile(client, spec)
          rollbackState.push({
            name: spec.name,
            existed: true,
            id: newId,
            replaced: true,
            priorDescription: existing.description,
          })
        }
      } else {
        const id = await createPutFile(client, spec)
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} RTR put-file(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPutFiles: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `RTR put-file deployment failed after ${deployed.length} of ${specs.length} put-file(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPutFiles: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Look up a put-file by its exact name; null when absent. */
export async function findPutFile(client: FalconClient, name: string): Promise<LiveRtrPutFile | null> {
  const found = await findEntityByIdentity(client, PUT_FILE_ENDPOINTS, name)
  return (found as LiveRtrPutFile | null) ?? null
}

/**
 * The create body fields as the RTR Admin multipart form expects them. Sent as
 * a JSON body until lib/falcon.ts supports multipart (see caveat). `content`
 * is the file body — in a real multipart request it is the required `file` part.
 */
export function putFileFormFields(spec: PutFileSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    content: spec.content,
    comments_for_audit_log: spec.commentsForAuditLog ?? DEPLOY_AUDIT_COMMENT,
  }
}

/** Create a put-file; returns the new id (or throws). MULTIPART — see caveat. */
export async function createPutFile(client: FalconClient, spec: PutFileSpec): Promise<string> {
  const res = await client.request('POST', PUT_FILE_ENDPOINTS.entity, { body: putFileFormFields(spec) })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create RTR put-file "${spec.name}" ${MULTIPART_HINT}: ${failure}`)
  }
  const created = parseEnvelope<LiveRtrPutFile | string>(res.body)?.resources?.[0]
  const id = typeof created === 'string' ? created : created?.id
  if (!id) {
    throw new Error(`RTR put-file "${spec.name}" was created but the API returned no id ${MULTIPART_HINT}`)
  }
  return id
}

/** Delete a put-file by id, tolerating 404 (already gone is the desired state). */
export async function deletePutFile(client: FalconClient, id: string): Promise<void> {
  const res = await client.request('DELETE', PUT_FILE_ENDPOINTS.entity, {
    query: { ids: id },
  })
  const failure = res.status === 404 ? null : falconFailure(res)
  if (failure) {
    throw new Error(`Failed to delete RTR put-file: ${failure}`)
  }
}

/**
 * True when the declared content's SHA-256 equals the live put-file's `sha256`.
 * When the API returned no sha256, the change cannot be verified — returns false
 * so deploy re-creates rather than silently skipping a possible content change.
 */
export async function contentMatches(content: string, liveSha256: string | undefined): Promise<boolean> {
  if (!liveSha256) return false
  const digest = await sha256Hex(content)
  return digest.toLowerCase() === liveSha256.trim().toLowerCase()
}

/** SHA-256 of a UTF-8 string, via the Web Crypto global (no node builtin import). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
