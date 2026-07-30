// Shared helpers for the Wazuh agent-groups config type (validate + deploy + drift).
//
// A Wazuh agent group bundles a set of agents under a shared configuration
// (agent.conf) that the manager pushes to every member. The group is created over
// the REST API; its shared config is an XML document uploaded separately. The
// canvas `comment` field is audit-only metadata and is never sent to the manager.

/** A Wazuh agent-group name: letters, numbers, dot, underscore, hyphen. */
export const GROUP_NAME_RE = /^[A-Za-z0-9._-]+$/

export interface XmlCheck {
  valid: boolean
  reason?: string
}

/**
 * Lightweight, network-free XML well-formedness check: strips comments, CDATA,
 * declarations and processing instructions, then walks the remaining tags with a
 * stack to confirm every element closes in order. A sanity gate for authoring —
 * not a full parser (attribute values containing '>' are out of scope). Verify
 * anything subtle against a live Wazuh 4.x manager.
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
