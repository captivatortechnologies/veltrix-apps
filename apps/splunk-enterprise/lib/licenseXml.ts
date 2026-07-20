// =============================================================================
// Splunk Enterprise license XML — pure parser + derived status (no I/O).
//
// A Splunk license is an XML document (the `.lic` file). Its shape is fixed and
// shallow — a single <license> with a <signature> (ignored here) and a <payload>
// carrying scalar fields plus a <features> list:
//
//   <license>
//     <signature>…</signature>
//     <payload>
//       <type>enterprise</type>
//       <group_id>Enterprise</group_id>
//       <label>My Splunk Enterprise License</label>
//       <quota>536870912000</quota>
//       <max_violations>5</max_violations>
//       <window_period>30</window_period>
//       <creation_time>1704067200</creation_time>     <!-- unix epoch seconds -->
//       <expiration_time>1735689600</expiration_time>  <!-- unix epoch seconds -->
//       <features><feature>Auth</feature><feature>FwdData</feature></features>
//       <sourcetypes/>
//       <guid>A1B2C3D4-…</guid>
//       <stack_id>enterprise</stack_id>
//     </payload>
//   </license>
//
// The parser is dependency-free on purpose. The platform only guarantees
// @veltrixsecops/app-sdk at runtime, and the app's local SDK is a symlink the
// client-bundle validator depends on — adding an npm dependency (which would run
// a full `npm install`) risks disturbing that link. Because the schema is fixed
// and shallow, a scoped, tolerant tag extractor is robust and fully unit-tested,
// which is the real intent behind "don't hand-roll a general XML parser".
// =============================================================================

export interface ParsedLicense {
  /** Human-readable license label. */
  label: string
  /** License kind, e.g. "enterprise", "free", "forwarder". From <type>. */
  licenseType: string
  /** License group, e.g. "Enterprise", "Trial". From <group_id>. */
  groupId: string
  /** Licensing stack this license belongs to, e.g. "enterprise". */
  stackId: string
  /** Daily indexing volume entitlement in BYTES. From <quota>. */
  quotaBytes: number
  /** Rolling license-usage window in days. From <window_period>. */
  windowPeriod: number
  /** Allowed quota violations within the window before enforcement. */
  maxViolations: number
  /** When the license was issued (from the <creation_time> epoch), or null. */
  creationTime: Date | null
  /** When the license expires (from the <expiration_time> epoch), or null. */
  expirationTime: Date | null
  /** Stable license identity — the dedupe key for recording. From <guid>. */
  guid: string
  /** Enabled feature flags. From <features><feature>…</feature></features>. */
  features: string[]
}

export type LicenseStatus = 'active' | 'expiring-soon' | 'expired' | 'unknown'

/** Licenses this close to expiry (in days) are surfaced as "expiring-soon". */
export const EXPIRING_SOON_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** Decode the XML entities that can legitimately appear in text values. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&') // must run last so decoded text isn't re-decoded
}

/** First `<tag>…</tag>` text within a scope, entity-decoded, or null. */
function firstTag(scope: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(scope)
  return match ? decodeEntities(match[1].trim()) : null
}

/** Every `<tag>…</tag>` text within a scope, entity-decoded. */
function allTags(scope: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(scope)) !== null) {
    const text = decodeEntities(match[1].trim())
    if (text) out.push(text)
  }
  return out
}

/** Coerce a tag value to a non-negative integer (0 when absent/invalid). */
function toInt(value: string | null): number {
  if (value == null || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Convert a unix-epoch-seconds string to a Date, or null when absent/invalid. */
function epochToDate(value: string | null): Date | null {
  if (!value) return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

/**
 * Parse a Splunk license XML document into its extracted fields. Tolerant of a
 * wrapping `.lic` file (it is just this XML) and of surrounding whitespace.
 * Returns `{ data }` on success or `{ error }` on a malformed document — the
 * same `{ data, error }` shape the app's other input parsers use (readByol,
 * readVersion).
 */
export function parseSplunkLicenseXml(xml: string): { data?: ParsedLicense; error?: string } {
  if (typeof xml !== 'string' || !xml.trim()) {
    return { error: 'License XML is required' }
  }

  const payloadMatch = /<payload\b[^>]*>([\s\S]*?)<\/payload>/i.exec(xml)
  if (!payloadMatch) {
    return { error: 'Not a Splunk license: no <payload> element found' }
  }
  const scope = payloadMatch[1]

  const featuresBlock = /<features\b[^>]*>([\s\S]*?)<\/features>/i.exec(scope)
  const features = featuresBlock ? allTags(featuresBlock[1], 'feature') : []

  const data: ParsedLicense = {
    label: firstTag(scope, 'label') ?? '',
    licenseType: firstTag(scope, 'type') ?? '',
    groupId: firstTag(scope, 'group_id') ?? '',
    stackId: firstTag(scope, 'stack_id') ?? '',
    quotaBytes: toInt(firstTag(scope, 'quota')),
    windowPeriod: toInt(firstTag(scope, 'window_period')),
    maxViolations: toInt(firstTag(scope, 'max_violations')),
    creationTime: epochToDate(firstTag(scope, 'creation_time')),
    expirationTime: epochToDate(firstTag(scope, 'expiration_time')),
    guid: firstTag(scope, 'guid') ?? '',
    features,
  }

  return { data }
}

/**
 * Derive a display status + whole days remaining from an expiration date.
 * `expiring-soon` when it expires within {@link EXPIRING_SOON_DAYS}; `expired`
 * once past; `unknown` when no valid expiration is known (some perpetual
 * licenses carry no expiration). Kept pure so the UI mapper and tests share it.
 */
export function deriveLicenseStatus(
  expiration: Date | null | undefined,
  now: Date = new Date(),
): { status: LicenseStatus; daysToExpiry: number | null } {
  if (!expiration || Number.isNaN(expiration.getTime())) {
    return { status: 'unknown', daysToExpiry: null }
  }
  const daysToExpiry = Math.ceil((expiration.getTime() - now.getTime()) / DAY_MS)
  let status: LicenseStatus
  if (daysToExpiry < 0) status = 'expired'
  else if (daysToExpiry < EXPIRING_SOON_DAYS) status = 'expiring-soon'
  else status = 'active'
  return { status, daysToExpiry }
}
