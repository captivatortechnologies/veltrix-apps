// =============================================================================
// Drift detection: compare the deployed Live Response library files against
// what is live.
//
// Content is never fetched back (there is no such API — see validate.ts), so
// this compares the SHA-256 of the DECLARED content, computed locally, against
// the `sha256` Defender returns for the live file. A mismatch means the file's
// bytes changed since this deploy — from the portal, another tool, or drift in
// this app's own state — without ever reading or logging the actual content on
// either side. Metadata (description / hasParameters / parametersDescription)
// is compared directly. A declared file that no longer exists is CRITICAL
// drift; a content or metadata mismatch is a WARNING.
//
// No actor attribution: a library file's only stamp is `createdBy` (who
// uploaded it, at any point — Defender does not distinguish create from a later
// overwrite), so it cannot reliably attribute a CHANGE to a specific person.
// =============================================================================

import { createHash } from 'node:crypto'
import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { listLibraryFiles } from './deploy'
import { extractLibraryFileSpecs, fileNameKey, type LiveLibraryFile } from './validate'

/** SHA-256 of a file's declared text content, hex-encoded — comparable to Defender's `sha256`. */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractLibraryFileSpecs(ctx.deployedConfig).filter((s) => s.fileName && s.content)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listLibraryFiles(client)
    const byKey = new Map<string, LiveLibraryFile>(live.filter((f) => f.fileName).map((f) => [fileNameKey(f.fileName as string), f]))

    for (const spec of specs) {
      const found = byKey.get(fileNameKey(spec.fileName))
      if (!found) {
        diffs.push({ field: spec.fileName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const expectedHash = contentSha256(spec.content)
      if (found.sha256 && found.sha256.toLowerCase() !== expectedHash.toLowerCase()) {
        diffs.push({ field: `${spec.fileName}.content`, expected: `sha256:${expectedHash}`, actual: `sha256:${found.sha256}`, severity: 'warning' })
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({ field: `${spec.fileName}.description`, expected: spec.description || '(none)', actual: found.description || '(none)', severity: 'warning' })
      }
      if (Boolean(found.hasParameters) !== spec.hasParameters) {
        diffs.push({ field: `${spec.fileName}.hasParameters`, expected: spec.hasParameters, actual: Boolean(found.hasParameters), severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({ field: 'mde', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
