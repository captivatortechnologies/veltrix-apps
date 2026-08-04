import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type DownloadableAcl } from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/** Normalize ACL content for comparison — line endings and trailing whitespace vary harmlessly. */
function normalizeAcl(text: string | undefined): string {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Drift for Downloadable ACLs: a declared DACL missing from ISE is critical
 * drift; a description, type or content mismatch is a warning. Read-only.
 * Best-effort — a DACL that can't be read is skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<DownloadableAcl>(base, 'downloadableacl', 'Downloadableacl', credential, settings)

  for (const item of items) {
    const spec = extractSpecs([item])[0]
    if (!spec.name) continue

    let existing
    try {
      existing = await client.findByName(spec.name)
    } catch {
      continue
    }

    if (!existing) {
      diffs.push({ field: `${spec.name}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getById(existing.id)
    } catch {
      continue
    }
    if (!live) continue

    const expectedDescription = spec.description
    const actualDescription = String(live.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${spec.name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    if (spec.daclType !== (live.daclType ?? '')) {
      diffs.push({ field: `${spec.name}.dacl_type`, expected: spec.daclType, actual: live.daclType ?? '', severity: 'warning' })
    }

    const expectedContent = normalizeAcl(spec.dacl)
    const actualContent = normalizeAcl(live.dacl)
    if (expectedContent !== actualContent) {
      diffs.push({ field: `${spec.name}.dacl`, expected: expectedContent, actual: actualContent, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
