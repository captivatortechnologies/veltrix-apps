import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, parseEnvelope, type FalconClient } from '../../lib/falcon'
import { findEntityByIdentity, type EntityEndpoints } from '../../lib/entityAdapter'
import { extractPutFileSpecs, type LiveRtrPutFile, type PutFileSpec } from './validate'

// Put-file CREATE is multipart/form-data only (verified against FalconPy
// real_time_response_admin) — the content is the required `file` part. Sent via
// FalconClient.requestMultipart. Worth a live smoke test.
//
// IMMUTABILITY: put-files have NO PATCH. GET never returns the stored bytes (only
// a `sha256`), so deploy is idempotent (a matching live sha256 is left untouched),
// a content change is converged by delete-then-recreate, and rollback of a
// replaced put-file can delete the new file but CANNOT restore the original bytes
// (surfaced in the rollback message). find/get/delete/drift use JSON + query params.

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
  /**
   * True when the original was deleted and the replacement upload did NOT land.
   * Put-file bytes are never readable from the API, so nothing can restore the
   * original — this flag exists so the operator is at least told which file is
   * gone and has to be re-uploaded by hand.
   */
  replacementMissing?: boolean
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
          //
          // Record the loss BEFORE the upload can throw. The moment the delete
          // lands the customer's file is gone for good, and the create that
          // follows can fail — which used to leave the result saying "failed
          // after 0 of 1", naming nothing. An entry marked `replacementMissing`
          // is the only thing that tells the operator which file to re-upload.
          await deletePutFile(client, existing.id)
          const entry: PutFileRollbackEntry = {
            name: spec.name,
            existed: true,
            replaced: true,
            priorDescription: existing.description,
            replacementMissing: true,
          }
          rollbackState.push(entry)
          const newId = await createPutFile(client, spec)
          entry.id = newId
          entry.replacementMissing = false
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
      }${destroyedNote(rollbackState)}`,
      artifacts: { baseUrl, deployedPutFiles: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Name the put-files whose original was deleted and whose replacement never
 * uploaded. Their bytes are unrecoverable through this API, so the message is
 * the only place an operator can learn what to restore by hand.
 */
function destroyedNote(state: PutFileRollbackEntry[]): string {
  const lost = state.filter((e) => e.replacementMissing).map((e) => e.name)
  if (lost.length === 0) return ''
  return (
    `. The previous version of ${lost.join(', ')} was deleted before the replacement ` +
    'uploaded and cannot be recovered from Falcon — re-upload it by hand.'
  )
}

/** Look up a put-file by its exact name; null when absent. */
export async function findPutFile(client: FalconClient, name: string): Promise<LiveRtrPutFile | null> {
  const found = await findEntityByIdentity(client, PUT_FILE_ENDPOINTS, name)
  return (found as LiveRtrPutFile | null) ?? null
}

/** The non-file form fields for put-file create (the content is the `file` part). */
export function putFileFormFields(spec: PutFileSpec): Record<string, string | undefined> {
  return {
    name: spec.name,
    description: spec.description,
    comments_for_audit_log: spec.commentsForAuditLog ?? DEPLOY_AUDIT_COMMENT,
  }
}

/** Create a put-file (content uploaded as the multipart `file` part); returns the new id. */
export async function createPutFile(client: FalconClient, spec: PutFileSpec): Promise<string> {
  const res = await client.requestMultipart('POST', PUT_FILE_ENDPOINTS.entity, {
    fields: putFileFormFields(spec),
    files: { file: { filename: spec.name, content: spec.content } },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create RTR put-file "${spec.name}": ${failure}`)
  }
  const created = parseEnvelope<LiveRtrPutFile | string>(res.body)?.resources?.[0]
  const id = typeof created === 'string' ? created : created?.id
  if (id) return id

  // The upload SUCCEEDED, so the put-file exists and is stageable by any RTR
  // operator. Re-resolve by name rather than reporting a failure that implies
  // nothing was written.
  const found = await findPutFile(client, spec.name)
  if (found?.id) return found.id
  throw new Error(
    `RTR put-file "${spec.name}" was created but the API returned no id and it could not be ` +
      'found by name — it EXISTS in the tenant and is not recorded for rollback',
  )
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
