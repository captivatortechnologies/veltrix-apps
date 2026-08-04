// =============================================================================
// Shared types + helpers for the Datadog Log Archives config type.
//
// An archive routes matching logs to long-term cold storage in a
// customer-owned S3/GCS/Azure destination, reached through a cloud
// integration ALREADY configured in Datadog (the archive references that
// integration by non-secret identifiers — an AWS role name / access key id,
// a GCP service-account email, an Azure AD client id — never a secret; the
// actual credential material lives in Datadog's separately-configured
// AWS/GCP/Azure integration, out of this app's scope). Verified against the
// official Datadog API docs:
//   List:   GET    /api/v2/logs/config/archives
//   Get:    GET    /api/v2/logs/config/archives/{archive_id}
//   Create: POST   /api/v2/logs/config/archives
//           https://docs.datadoghq.com/api/latest/logs-archives/create-an-archive/
//           body: { "data": { "type": "archives", "attributes": { name,
//           query, destination: { type: "s3"|"gcs"|"azure", ...type-specific
//           fields... }, rehydration_tags?, rehydration_max_scan_size_in_gb? } } }
//   Update: PUT    /api/v2/logs/config/archives/{archive_id}
//   Delete: DELETE /api/v2/logs/config/archives/{archive_id}
//
// NOT MANAGED (flagged, not faked):
//   - Archive ORDER — a separate GET/PUT /api/v2/logs/config/archive-order
//     singleton, controlling which archive rule an ambiguously-matching log
//     falls into first.
//   - Reader role grants — a separate
//     GET/POST/DELETE /api/v2/logs/config/archives/{archive_id}/readers
//     sub-resource (who can rehydrate from this archive).
// Both are out of scope for this release.
//
// `destination` varies structurally by cloud (S3 needs bucket + integration;
// GCS needs bucket + integration; Azure needs container + storage_account +
// integration), so — like Log Pipeline processors — it is authored as a
// single JSON object and only shape/enum-checked at the common level (a
// valid "type", and the type-appropriate required key present); Datadog's
// own API is the final arbiter of the full per-cloud schema.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const DESTINATION_TYPES = ['s3', 'gcs', 'azure'] as const
export const MAX_NAME_LENGTH = 255

export interface ArchiveAttributes {
  name?: string
  query?: string
  destination?: Record<string, unknown>
  rehydration_tags?: string[]
  rehydration_max_scan_size_in_gb?: number
  state?: string
  [key: string]: unknown
}

export interface ArchiveResource {
  id?: string
  type?: string
  attributes?: ArchiveAttributes
}

/** The managed subset of an archive's attributes — fully declared on every deploy. */
export interface ArchiveBody {
  name: string
  query: string
  destination: Record<string, unknown>
  rehydration_tags: string[]
  rehydration_max_scan_size_in_gb?: number
}

export interface ArchiveSpec {
  name: string
  query: string
  destinationRaw: string
  rehydrationTags: string[]
  maxScanSizeRaw: string
}

export function readStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : String(v ?? '')))
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

export function extractArchiveSpec(fields: Record<string, unknown>): ArchiveSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const num = (value: unknown): string => (typeof value === 'number' ? String(value) : str(value))
  return {
    name: str(fields.name),
    query: str(fields.query),
    destinationRaw: typeof fields.destination === 'string' ? fields.destination.trim() : '',
    rehydrationTags: readStringArray(fields.rehydration_tags),
    maxScanSizeRaw: num(fields.rehydration_max_scan_size_in_gb),
  }
}

export function extractArchiveSpecs(canvas: CanvasSnapshot): ArchiveSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractArchiveSpec(item.fields ?? {}))
}

export function archiveKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findArchiveByName(archives: ArchiveResource[], name: string): ArchiveResource | null {
  const key = archiveKey(name)
  if (!key) return null
  return archives.find((a) => typeof a.attributes?.name === 'string' && archiveKey(a.attributes.name) === key) ?? null
}

export interface ParsedJson<T> {
  value: T | undefined
  ok: boolean
}

export function parseJsonObject(raw: string): ParsedJson<Record<string, unknown>> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    if (!isJsonObject(parsed)) return { value: undefined, ok: false }
    return { value: parsed, ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an optional numeric field: '' -> undefined; otherwise a finite number, or NaN when malformed. */
export function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : NaN
}

export function buildArchiveBody(spec: ArchiveSpec, destination: Record<string, unknown>, maxScanSize: number | undefined): ArchiveBody {
  const body: ArchiveBody = {
    name: spec.name,
    query: spec.query,
    destination,
    rehydration_tags: spec.rehydrationTags,
  }
  if (maxScanSize !== undefined) body.rehydration_max_scan_size_in_gb = maxScanSize
  return body
}

/** Rebuild an ArchiveBody from captured LIVE attributes (rollback restore path). */
export function attributesToBody(attrs: ArchiveAttributes): ArchiveBody {
  const body: ArchiveBody = {
    name: String(attrs.name ?? ''),
    query: String(attrs.query ?? ''),
    destination: isJsonObject(attrs.destination) ? attrs.destination : {},
    rehydration_tags: Array.isArray(attrs.rehydration_tags) ? attrs.rehydration_tags : [],
  }
  if (typeof attrs.rehydration_max_scan_size_in_gb === 'number') {
    body.rehydration_max_scan_size_in_gb = attrs.rehydration_max_scan_size_in_gb
  }
  return body
}

export function toPayload(body: ArchiveBody): { data: { type: 'archives'; attributes: ArchiveBody } } {
  return { data: { type: 'archives', attributes: body } }
}
