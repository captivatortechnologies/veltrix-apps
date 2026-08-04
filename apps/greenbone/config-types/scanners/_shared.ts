// Shared helpers for the Greenbone Scanners config type (deploy + rollback +
// drift). A scanner is a named scan-engine endpoint (beyond the feed-provided
// "OpenVAS Default"). Applied over GMP (XML over TLS). The scanner NAME is the
// stable identity used to upsert — gvmd does not enforce unique names, so this
// app treats the name as the key (last one wins).
//
// FLAG: create_scanner hard-requires an EXISTING GMP credential id (see
// lib/gmp/scanners.ts) — this app does not create/store GMP credentials
// (secret material), so credentialId always references a credential the
// operator created directly in the Greenbone UI.

import type { ScannerInput, GmpScannerFull } from '../../lib/gmp/scanners'
import { SCANNER_TYPE_OPENVAS } from '../../lib/gmp/scanners'

export { SCANNER_TYPE_OPENVAS }

export function buildScannerInput(fields: Record<string, unknown>): ScannerInput {
  return {
    name: String(fields.name ?? '').trim(),
    host: String(fields.host ?? '').trim(),
    port: Number(fields.port) || 9391,
    type: String(fields.type ?? '').trim() || SCANNER_TYPE_OPENVAS,
    credentialId: String(fields.credentialId ?? '').trim(),
    caPub: String(fields.caPub ?? '').trim(),
    comment: String(fields.comment ?? '').trim(),
  }
}

/** Find a live scanner by name (trimmed, case-sensitive). */
export function findScannerByName(scanners: GmpScannerFull[], name: string): GmpScannerFull | null {
  const n = name.trim()
  if (!n) return null
  return scanners.find((s) => s.name.trim() === n) ?? null
}
