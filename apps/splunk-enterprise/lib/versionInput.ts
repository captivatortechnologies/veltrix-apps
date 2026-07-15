// =============================================================================
// Splunk version request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules can be unit
// tested without pulling in Fastify or the aws-sdk-backed lib/s3. The client
// may only supply an http(s) download URL; S3 package references are set by the
// upload flow (POST /versions/:id/package-url), never by the client.
// =============================================================================

import type { VersionInput } from './db/versions'

const EMPTY_VERSION: VersionInput = {
  version: '',
  releaseDate: new Date(0),
  downloadUrl: null,
  releaseNotes: null,
  isActive: true,
  isLatest: false,
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Coerce/validate a Splunk version record from a request body. */
export function readVersion(body: any): { data: VersionInput; error?: string } {
  const version = typeof body?.version === 'string' ? body.version.trim() : ''
  if (!version) return { data: EMPTY_VERSION, error: 'Version is required' }
  if (version.length > 40) return { data: EMPTY_VERSION, error: 'Version must be 40 characters or fewer' }
  if (!/^[0-9][0-9A-Za-z._-]*$/.test(version))
    return {
      data: EMPTY_VERSION,
      error: 'Version must start with a digit and use only letters, numbers, dots, hyphens or underscores',
    }

  let releaseDate = new Date()
  if (body?.releaseDate) {
    const parsed = new Date(body.releaseDate)
    if (Number.isNaN(parsed.getTime())) return { data: EMPTY_VERSION, error: 'Release date is invalid' }
    releaseDate = parsed
  }

  const downloadUrl = typeof body?.downloadUrl === 'string' ? body.downloadUrl.trim() : ''
  if (downloadUrl && !/^https?:\/\//i.test(downloadUrl))
    return { data: EMPTY_VERSION, error: 'Download URL must be an http(s) URL' }

  return {
    data: {
      version,
      releaseDate,
      downloadUrl: downloadUrl || null,
      releaseNotes: typeof body?.releaseNotes === 'string' ? body.releaseNotes.trim() || null : null,
      isActive: toBool(body?.isActive, true),
      isLatest: toBool(body?.isLatest, false),
    },
  }
}
