// =============================================================================
// Minimal, dependency-free XML helpers for the Jamf Pro Classic API
// (`/JSSResource`, XML request/response).
//
// The Classic API predates the modern JSON API and still owns some resources
// this app manages in wave 2 (computer groups, policies) — see
// https://developer.jamf.com/jamf-pro/reference/findcomputergroups and
// https://developer.jamf.com/jamf-pro/reference/findpoliciesbyid, both of
// which document XML request/response bodies rooted at
// `https://<host>/JSSResource`.
//
// Apps may not add npm dependencies, so this hand-rolls JUST ENOUGH of an XML
// parser/serializer for the FIXED, well-known Classic schemas this app reads
// and writes (computer_group, policy, and the {id,name} list shape shared by
// every Classic "find all" endpoint). It is NOT a general-purpose XML engine:
// `extractElement` assumes the target tag never nests a child of the SAME
// name — true for every element this app touches (general, scope, criteria,
// scripts, package_configuration, computer_groups, exclusions, …) — so a
// simple "first open tag → first matching close tag" scan is correct and
// sufficient. Callers that need a tag appearing at multiple nesting depths
// (e.g. `computer_groups` under both `scope` and `scope.exclusions`) extract
// the appropriate outer element FIRST and then search within that substring.
// =============================================================================

export function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function xmlUnescape(value: string): string {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Build one leaf element, e.g. `tag('name', 'Install Rosetta')` -> `<name>Install Rosetta</name>`. */
export function tag(name: string, value: string | number | boolean): string {
  return `<${name}>${xmlEscape(String(value))}</${name}>`
}

/**
 * Find the full outer XML (`<tagName>…</tagName>` or a self-closing
 * `<tagName/>`) of the FIRST occurrence of `tagName` in `xml`. Returns null
 * when absent or malformed (unterminated). See the file header for the
 * "no same-name nesting" assumption this relies on.
 */
export function extractElement(xml: string, tagName: string): string | null {
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?(/?)>`)
  const openMatch = openRe.exec(xml)
  if (!openMatch) return null
  if (openMatch[1] === '/') return openMatch[0]

  const closeTag = `</${tagName}>`
  const closeIndex = xml.indexOf(closeTag, openMatch.index + openMatch[0].length)
  if (closeIndex === -1) return null
  return xml.slice(openMatch.index, closeIndex + closeTag.length)
}

/** The unescaped, trimmed text content of the first `tagName` element; `''` when absent or self-closing/empty. */
export function extractText(xml: string, tagName: string): string {
  const el = extractElement(xml, tagName)
  if (el === null) return ''
  if (el.endsWith('/>')) return ''
  const inner = el.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '')
  return xmlUnescape(inner.trim())
}

/** Every top-level, non-overlapping occurrence of `tagName` in `xml`, in document order. */
export function extractAll(xml: string, tagName: string): string[] {
  const results: string[] = []
  let rest = xml
  let offset = 0
  for (;;) {
    const el = extractElement(rest, tagName)
    if (el === null) break
    const idx = rest.indexOf(el)
    results.push(el)
    offset = idx + el.length
    rest = rest.slice(offset)
  }
  return results
}

/**
 * Replace the value of leaf element `leafTag` inside `blockXml` (the full
 * `<container>…</container>` outer XML), or append it just before
 * `containerCloseTag` (e.g. `</general>`) when absent. Used to patch a few
 * managed leaves inside a larger element while leaving every sibling leaf
 * untouched — the safe way to update part of a Classic API document without
 * risking a full-document replace wiping unrelated configuration.
 */
export function setLeaf(
  blockXml: string,
  leafTag: string,
  value: string | number | boolean,
  containerCloseTag: string,
): string {
  const newTag = tag(leafTag, value)
  const existing = extractElement(blockXml, leafTag)
  if (existing !== null) {
    const idx = blockXml.indexOf(existing)
    return blockXml.slice(0, idx) + newTag + blockXml.slice(idx + existing.length)
  }
  const closeIdx = blockXml.lastIndexOf(containerCloseTag)
  if (closeIdx === -1) return blockXml + newTag
  return blockXml.slice(0, closeIdx) + newTag + blockXml.slice(closeIdx)
}

/**
 * Replace the top-level `tagName` element inside `xml` with `replacementXml`,
 * or insert it just before `rootCloseTag` (e.g. `</policy>`) when absent. Used
 * to swap out one whole managed section (scope, scripts, package_configuration)
 * of a larger document while leaving every other top-level section untouched.
 */
export function replaceTopLevelElement(
  xml: string,
  tagName: string,
  replacementXml: string,
  rootCloseTag: string,
): string {
  const existing = extractElement(xml, tagName)
  if (existing !== null) {
    const idx = xml.indexOf(existing)
    return xml.slice(0, idx) + replacementXml + xml.slice(idx + existing.length)
  }
  const closeIdx = xml.lastIndexOf(rootCloseTag)
  if (closeIdx === -1) return xml + replacementXml
  return xml.slice(0, closeIdx) + replacementXml + xml.slice(closeIdx)
}

/** One `{id, name}` reference, the shape shared by every Classic "find all" list endpoint and every scope/scripts/packages list item. */
export interface ClassicRef {
  id: string
  name: string
}

/** Parse a Classic "find all" list response (`<computer_groups><computer_group>…` / `<policies><policy>…` / `<packages><package>…`) into `{id, name}` refs. */
export function parseIdNameList(xml: string, itemTag: string): ClassicRef[] {
  return extractAll(xml, itemTag)
    .map((el) => ({ id: extractText(el, 'id'), name: extractText(el, 'name') }))
    .filter((ref) => ref.id && ref.name)
}

/** Case-insensitive, trimmed lookup key — consistent with the modern-API config types' name matching. */
export function classicRefKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Index a list of `{id, name}` refs by name (case-insensitive; first match wins on a live duplicate). */
export function indexRefsByName(refs: ClassicRef[]): Map<string, ClassicRef> {
  const byName = new Map<string, ClassicRef>()
  for (const ref of refs) {
    const key = classicRefKey(ref.name)
    if (!byName.has(key)) byName.set(key, ref)
  }
  return byName
}

/** Build one `<tagName><id>…</id><name>…</name></tagName>` reference element (a resolved scope/scripts/packages list item). */
export function refXml(tagName: string, ref: ClassicRef): string {
  return `<${tagName}>${tag('id', ref.id)}${tag('name', ref.name)}</${tagName}>`
}

/**
 * Render a Classic API error body as one readable line. Unlike the modern
 * API's `ApiError` JSON envelope, the Classic API typically returns a plain
 * text message or a small HTML page (e.g. a 401 from the servlet container) —
 * this strips tags rather than trying to parse structure.
 */
export function classicErrorMessage(status: number, body: string): string {
  const stripped = (body ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return `HTTP ${status}`
  return `HTTP ${status}: ${stripped.length > 300 ? `${stripped.slice(0, 297)}...` : stripped}`
}
