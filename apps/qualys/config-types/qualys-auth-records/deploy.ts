import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  qualysReturnId,
  qualysWriteError,
  xmlText,
  type QualysClient,
  type QualysParams,
} from '../../lib/qualys'
import { flattenScalarParams, parseFlatScalarObject } from '../lib/qualysJson'
import {
  authRecordBlockTag,
  authRecordKey,
  extractAuthRecordSpecs,
  type AuthRecordSpec,
  type LiveAuthRecord,
} from './validate'

export interface AuthRecordRollbackEntry {
  key: string
  label: string
  recordType: string
  existed: boolean
  id?: string
  prior?: LiveAuthRecord
}

/** Path for a technology's authentication record endpoint (create/update/delete/list). */
export function authRecordPath(recordType: string): string {
  return `/api/2.0/fo/auth/${recordType}/`
}

/** Normalize a comma/whitespace-separated IP list into a comma-separated string. */
export function normalizeIps(raw: string): string {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
}

/**
 * Deploy Qualys authentication records via the classic v2 API.
 *
 * Identity is the (record type, title) natural key — each technology is a
 * separate endpoint/namespace. Records are grouped by type so each type's live
 * set is listed once, then each declared record is matched by title within its
 * type and updated or created. Credentials are supplied as a flat JSON object
 * and sent verbatim on every deploy — they are WRITE-ONLY: Qualys never returns
 * them, so this app never diffs, stores or logs them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractAuthRecordSpecs(ctx.canvas).filter(
    (s) => s.recordType && s.title && !parseFlatScalarObject(s.credentialsJson).error,
  )
  const rollbackState: AuthRecordRollbackEntry[] = []
  const createdByType: Record<string, string[]> = {}
  const deployed: string[] = []

  try {
    const byType = new Map<string, Map<string, LiveAuthRecord>>()
    for (const recordType of new Set(specs.map((s) => s.recordType))) {
      const live = await listAuthRecords(client, recordType)
      byType.set(recordType, new Map(live.map((r) => [r.title.trim().toLowerCase(), r])))
    }

    for (const spec of specs) {
      const label = `${spec.recordType}:${spec.title}`
      const key = authRecordKey(spec)
      const live = byType.get(spec.recordType)?.get(spec.title.trim().toLowerCase())
      const path = authRecordPath(spec.recordType)

      if (live) {
        rollbackState.push({ key, label, recordType: spec.recordType, existed: true, id: live.id, prior: live })
        const res = await client.post(path, buildUpdateParams(spec, live.id))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to update ${label} authentication record: ${failed}`)
      } else {
        const res = await client.post(path, buildCreateParams(spec))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to create ${label} authentication record: ${failed}`)
        const newId = qualysReturnId(res.body)
        if (!newId) throw new Error(`${label} authentication record was created but the API returned no id`)
        rollbackState.push({ key, label, recordType: spec.recordType, existed: false, id: newId })
        ;(createdByType[spec.recordType] ??= []).push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} authentication record(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedAuthRecords: deployed },
      rollbackData: { previousState: rollbackState, createdByType },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authentication record deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedAuthRecords: deployed },
      rollbackData: { previousState: rollbackState, createdByType },
    }
  }
}

// --- Helpers ---

/** List every record of one technology, following the trailing WARNING/URL pagination pointer. */
export async function listAuthRecords(client: QualysClient, recordType: string): Promise<LiveAuthRecord[]> {
  const blockTag = authRecordBlockTag(recordType) ?? `AUTH_${recordType.toUpperCase()}`
  const res = await client.list(authRecordPath(recordType), {}, blockTag)
  if (!res.ok) {
    throw new Error(
      `Failed to list ${recordType} authentication records: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.blocks.map(parseAuthRecordBlock).filter((r) => r.id && r.title)
}

/** Parse one technology's repeating record block (e.g. `<AUTH_UNIX>`) into a LiveAuthRecord. */
export function parseAuthRecordBlock(block: string): LiveAuthRecord {
  return {
    id: xmlText(block, 'ID'),
    title: xmlText(block, 'TITLE'),
    comments: xmlText(block, 'COMMENTS'),
  }
}

/** Build the shared create/update params from a spec (excludes action/ids). */
export function authRecordParams(spec: AuthRecordSpec): QualysParams {
  const credentials = parseFlatScalarObject(spec.credentialsJson).value ?? {}
  // First-class fields win over any collision in the credentials JSON.
  const params: QualysParams = { ...flattenScalarParams(credentials) }
  params.title = spec.title
  const ips = normalizeIps(spec.ips)
  if (ips) params.ips = ips
  if (spec.comments) params.comments = spec.comments
  return params
}

export function buildCreateParams(spec: AuthRecordSpec): QualysParams {
  return { action: 'create', ...authRecordParams(spec) }
}

export function buildUpdateParams(spec: AuthRecordSpec, id: string): QualysParams {
  return { action: 'update', ids: id, ...authRecordParams(spec) }
}
