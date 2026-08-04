// Shared helpers for the Wazuh Manager-Configuration config type (validate +
// deploy + drift). This is a SINGLETON: the manager exposes exactly one
// ossec.conf, replaced whole-file (same content-replace model as this app's
// other XML config types — the XML well-formedness check below is duplicated
// from custom-rules/custom-decoders/agent-groups by the same convention). The
// canvas `comment` field is audit-only and is never sent to the manager.
//
// Field shapes verified against the Wazuh API OpenAPI spec (api/api/spec/spec.yaml,
// tag v4.14.7, github.com/wazuh/wazuh) — GET/PUT `/manager/configuration`
// (`raw=true` returns the literal file per the `raw` parameter's documented
// "Format response in plain text"; PUT's requestBody is `application/octet-stream`).

export interface XmlCheck {
  valid: boolean
  reason?: string
}

/**
 * Lightweight, network-free XML well-formedness check: strips comments, CDATA,
 * declarations and processing instructions, then walks the remaining tags with a
 * stack to confirm every element closes in order. A sanity gate for authoring —
 * not a full parser (attribute values containing '>' are out of scope).
 */
export function checkXml(text: unknown): XmlCheck {
  const body = String(text ?? '').trim()
  if (!body) return { valid: false, reason: 'empty' }
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<![^>]*>/g, '')
  const stack: string[] = []
  let sawElement = false
  for (const tok of cleaned.match(/<[^>]+>/g) ?? []) {
    const inner = tok.slice(1, -1).trim()
    if (!inner) continue
    if (inner.endsWith('/')) {
      sawElement = true
      continue
    }
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().split(/\s/)[0]
      const top = stack.pop()
      if (top !== name) return { valid: false, reason: `unexpected </${name}>` }
    } else {
      stack.push(inner.split(/\s/)[0])
      sawElement = true
    }
  }
  if (stack.length) return { valid: false, reason: `unclosed <${stack[stack.length - 1]}>` }
  if (!sawElement) return { valid: false, reason: 'no XML elements' }
  return { valid: true }
}

/** Normalize XML for drift comparison: drop comments + inter-tag whitespace, collapse runs. */
export function normalizeXml(text: unknown): string {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether the document's outermost element is Wazuh's documented `<ossec_config>` root. */
export function hasOssecConfigRoot(text: unknown): boolean {
  const body = String(text ?? '').trim()
  const withoutProlog = body.replace(/^<\?[\s\S]*?\?>/, '').replace(/^<!--[\s\S]*?-->/, '').trim()
  return /^<ossec_config\b/.test(withoutProlog)
}
