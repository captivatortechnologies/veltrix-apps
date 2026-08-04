import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type AllowedProtocols } from '../../lib/iseApi'
import { extractSpecs, type AllowedProtocolsSpec } from './_shared'

/** Every boolean flag this app manages — the (identical) key on both the canvas spec and the live ERS resource. */
const BOOL_FIELDS: Array<keyof AllowedProtocolsSpec & keyof AllowedProtocols> = [
  'allowPapAscii',
  'allowChap',
  'allowMsChapV1',
  'allowMsChapV2',
  'allowEapMd5',
  'allowLeap',
  'allowEapTls',
  'allowPeap',
  'allowEapTtls',
  'allowEapFast',
  'allowTeap',
  'processHostLookup',
]

/**
 * Drift for Allowed Protocols: a declared service missing from ISE is
 * critical drift; a mismatch in any managed top-level flag, description or
 * preferred EAP protocol is a warning. The nested eapFast/eapTls/.../teap
 * sub-objects are never compared — this app doesn't manage them (see the
 * module doc). Read-only. Best-effort — a service that can't be read is
 * skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<AllowedProtocols>(base, 'allowedprotocols', 'Allowedprotocols', credential, settings)

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

    for (const field of BOOL_FIELDS) {
      const expected = Boolean(spec[field])
      const actual = Boolean(live[field])
      if (expected !== actual) {
        diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity: 'warning' })
      }
    }

    const expectedPreferred = spec.preferredEapProtocol
    const actualPreferred = String(live.preferredEapProtocol ?? '').trim()
    if (expectedPreferred !== actualPreferred) {
      diffs.push({ field: `${spec.name}.preferred_eap_protocol`, expected: expectedPreferred, actual: actualPreferred, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
