// =============================================================================
// GMP entity — Scanners (<create_scanner>/<get_scanners>/<modify_scanner>/
// <delete_scanner>). A scanner is a named scan-engine endpoint a scan task can
// target (the feed-provided "OpenVAS Default" is the common case; this config
// type is for ADDITIONAL scanner endpoints — a remote OSP sensor, a CVE
// scanner, etc.). Built on the transport + wire-format primitives in
// ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_scanner
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_scanner
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_scanners.py).
//
// FLAGS — verify against a live gvmd (GMP is version-specific):
//   * CREDENTIAL IS A HARD PREREQUISITE: create_scanner's RNC requires a
//     <credential id="…"/> child — every scanner needs an EXISTING GMP
//     credential (a client-certificate credential, in the classic OSP model).
//     This app does not create or store GMP credentials (see the Credentials
//     DROP in the app README's Coverage section — all 7 GMP credential types
//     carry secret material) — the operator creates the credential directly in
//     the Greenbone UI/gvmd and this config type only REFERENCES its UUID.
//   * TYPE ENUM: the GMP 22.5 doc text itself only names type "1" (OSP) and "2"
//     (OpenVAS classic). python-gvm's current ScannerType enum additionally
//     lists "3" (CVE) and "5" (Greenbone Sensor), with "1" noted as removed in
//     newer GVM — the wire-level <type> element is plain text (no schema
//     enum), so nothing stops sending 3/5, but this is UNVERIFIED against a
//     22.5 gvmd specifically. Only "2" is doc-confirmed; 3/5 are offered but
//     flagged in the canvas helpText.
//   * MODIFY RESENDS EVERYTHING: modify_scanner's RNC declares host/port/type
//     as non-optional elements (no "?"), unlike most other modify_* commands
//     in this app — this builder therefore ALWAYS resends
//     name/host/port/type/ca_pub/credential on modify, never a partial patch.
//   * ca_pub is a required ELEMENT in the RNC (not marked optional) though its
//     CONTENT may be empty for a scanner that needs no custom CA pin — this
//     builder always emits the element, defaulting to an empty string.
//   * verify_scanner (a live connectivity probe) is a runtime action, not
//     config — intentionally not wired to anything here (see app README).
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

/** Doc-confirmed (GMP 22.5 text): OpenVAS classic scanner. Safe to create. */
export const SCANNER_TYPE_OPENVAS = '2'
/** UNVERIFIED against 22.5 specifically — see FLAGS. Offered for completeness. */
export const SCANNER_TYPE_CVE = '3'
/** UNVERIFIED against 22.5 specifically — see FLAGS. Offered for completeness. */
export const SCANNER_TYPE_GREENBONE_SENSOR = '5'

export function buildGetScannersFullCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_scanners filter="${escapeXmlAttr(filter)}"/>`
}

export interface ScannerInput {
  name: string
  host: string
  port: number
  type: string
  credentialId: string
  caPub?: string
  comment?: string
}

export function buildCreateScannerCommand(s: ScannerInput): string {
  const parts = [
    `<name>${escapeXmlText(s.name)}</name>`,
    `<host>${escapeXmlText(s.host)}</host>`,
    `<port>${escapeXmlText(s.port)}</port>`,
    `<type>${escapeXmlText(s.type)}</type>`,
    `<ca_pub>${escapeXmlText(s.caPub ?? '')}</ca_pub>`,
    `<credential id="${escapeXmlAttr(s.credentialId)}"/>`,
  ]
  if (s.comment && String(s.comment).trim()) parts.push(`<comment>${escapeXmlText(s.comment)}</comment>`)
  return `<create_scanner>${parts.join('')}</create_scanner>`
}

/** Always resends name/host/port/type/ca_pub/credential — see FLAGS ("MODIFY RESENDS EVERYTHING"). */
export function buildModifyScannerCommand(scannerId: string, s: ScannerInput): string {
  const parts = [
    `<name>${escapeXmlText(s.name)}</name>`,
    `<host>${escapeXmlText(s.host)}</host>`,
    `<port>${escapeXmlText(s.port)}</port>`,
    `<type>${escapeXmlText(s.type)}</type>`,
    `<ca_pub>${escapeXmlText(s.caPub ?? '')}</ca_pub>`,
    `<credential id="${escapeXmlAttr(s.credentialId)}"/>`,
  ]
  if (s.comment !== undefined) parts.push(`<comment>${escapeXmlText(s.comment)}</comment>`)
  return `<modify_scanner scanner_id="${escapeXmlAttr(scannerId)}">${parts.join('')}</modify_scanner>`
}

export function buildDeleteScannerCommand(scannerId: string, ultimate = true): string {
  return `<delete_scanner scanner_id="${escapeXmlAttr(scannerId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpScannerFull {
  id: string
  name: string
  comment: string
  host: string
  port: string
  type: string
  caPub: string
  credentialId: string
}

/** Parse `<scanner id="…">…</scanner>` elements out of a get_scanners response (full field set, unlike parseScanners() in ../greenboneApi.ts which is name-only for scan-task lookups). */
export function parseScannersFull(xml: string): GmpScannerFull[] {
  const out: GmpScannerFull[] = []
  const re = /<scanner\b([^>]*)>([\s\S]*?)<\/scanner>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const credMatch = /<credential\b([^>]*)>/.exec(body)
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      host: firstChildText(body, 'host') ?? '',
      port: firstChildText(body, 'port') ?? '',
      type: firstChildText(body, 'type') ?? '',
      caPub: firstChildText(body, 'ca_pub') ?? '',
      credentialId: credMatch ? (attrsFrom(credMatch[1]).id ?? '') : '',
    })
  }
  return out
}
