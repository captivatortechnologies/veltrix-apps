// =============================================================================
// License record request validation (pure).
//
// Extracted from server/index.ts so the POST /licenses body coercion can be unit
// tested without Fastify. Mirrors the app's other input parsers (readByol,
// readVersion): returns `{ xml }` on success or `{ error }` on a bad body.
// =============================================================================

// A single license `.lic` is a few KB; 512 KB is a generous ceiling that still
// rejects a runaway/accidental paste before it ever reaches the XML parser.
const MAX_XML_BYTES = 512 * 1024

/** Coerce + validate the `{ xml }` body of a record-license request. */
export function readLicenseInput(body: unknown): { xml?: string; error?: string } {
  const raw = (body ?? {}) as { xml?: unknown }
  const xml = typeof raw.xml === 'string' ? raw.xml.trim() : ''
  if (!xml) return { error: 'License XML is required' }
  if (xml.length > MAX_XML_BYTES) return { error: 'License XML is too large' }
  return { xml }
}
