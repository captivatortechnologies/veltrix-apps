import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient } from '../../lib/visionOneApi'
import {
  CUSTOM_SCRIPT_LIST,
  findScriptByFileName,
  normalizeContent,
  scriptItemPath,
  scriptsFromResponse,
} from './_shared'

/**
 * Drift for custom scripts — only asserted when the live list reads back cleanly.
 * A declared script that is ABSENT is drift (someone deleted it). For a present
 * script we compare the file type and description (from the list) and the script
 * CONTENTS (downloaded per matched script; line endings normalized so a benign
 * CRLF/LF difference is not reported). Content download is best-effort — a failed
 * download skips the content check rather than raising false drift.
 * Read-only: GET /response/customScripts (+ per-script GET for contents).
 *
 * VERIFY the list response shape + download endpoint against a live Vision One
 * tenant.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.get(CUSTOM_SCRIPT_LIST)
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = scriptsFromResponse(res.json)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const fileName = String(item.fields.fileName ?? '').trim()
    if (!fileName) continue
    const match = findScriptByFileName(live, fileName)

    if (!match) {
      diffs.push({ field: `${fileName}.present`, expected: 'true', actual: 'false', severity: 'warning' })
      continue
    }

    const expectedType = String(item.fields.fileType ?? '').trim()
    if (expectedType) {
      const actualType = String(match.fileType ?? '').trim()
      if (actualType && actualType !== expectedType) {
        diffs.push({ field: `${fileName}.fileType`, expected: expectedType, actual: actualType, severity: 'warning' })
      }
    }

    const expectedDesc = String(item.fields.description ?? '').trim()
    if (expectedDesc) {
      const actualDesc = String(match.description ?? '').trim()
      if (actualDesc !== expectedDesc) {
        diffs.push({ field: `${fileName}.description`, expected: expectedDesc, actual: actualDesc, severity: 'warning' })
      }
    }

    // Contents: compare against the downloaded live script (best-effort).
    if (match.id) {
      try {
        const dl = await client.get(scriptItemPath(match.id))
        if (dl.ok) {
          const expectedContent = normalizeContent(String(item.fields.scriptContent ?? ''))
          const actualContent = normalizeContent(dl.body)
          if (expectedContent && expectedContent !== actualContent) {
            diffs.push({ field: `${fileName}.content`, expected: 'declared script contents', actual: 'differs on the tenant', severity: 'warning' })
          }
        }
      } catch {
        // download failed — skip the content check for this script
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
