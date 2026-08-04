import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient, type RecordedFutureClient } from '../../lib/recordedFutureApi'
import { contentSha256, fusionPaths, normalizeEtag, normalizePath } from './_shared'

/**
 * Drift for Fusion Files: for each declared file, confirm it exists and that its
 * live ETag (Fusion's own SHA-256 of the file's bytes) matches the SHA-256 of the
 * DECLARED content computed locally — the file's bytes are never fetched back.
 * Read-only: HEAD /fusion/v3/files/{path}.
 *
 * Best-effort — a file whose ETag can't be read (network error, or a header
 * shape other than a bare/quoted hex digest) is skipped rather than asserting
 * false drift.
 */
async function liveEtag(client: RecordedFutureClient, path: string): Promise<{ found: boolean; etag: string }> {
  const res = await client.raw('HEAD', fusionPaths.file(path))
  if (res.status === 404) return { found: false, etag: '' }
  if (!res.ok) return { found: false, etag: '' }
  return { found: true, etag: normalizeEtag(res.headers.get('etag')) }
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, component, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const path = normalizePath(item.fields.path)
    if (!path) continue
    const content = String(item.fields.content ?? '')

    let state
    try {
      state = await liveEtag(client, path)
    } catch {
      continue // best-effort: transient error — no drift asserted for this file
    }

    if (!state.found) {
      diffs.push({ field: path, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }
    if (!state.etag) continue // ETag unreadable — no drift asserted

    const expected = contentSha256(content)
    if (state.etag !== expected) {
      diffs.push({ field: `${path}.content`, expected: `sha256:${expected}`, actual: `sha256:${state.etag}`, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
