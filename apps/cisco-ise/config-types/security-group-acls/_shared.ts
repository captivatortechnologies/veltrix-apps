// Shared helpers for the Security Group ACLs config type (validate + deploy +
// rollback + drift). Field shapes verified against the community pyise-ers
// ERS client (add_sgacl — github.com/falkowich/pyise-ers, pyiseers/pyiseers.py).

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { Sgacl } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000
export const IP_VERSIONS = new Set(['IPV4', 'IPV6', 'IP_AGNOSTIC'])
export const DEFAULT_IP_VERSION = 'IP_AGNOSTIC'
/** ISE's own SGACL naming rule (pyise-ers's `_sgacl_name_test`): starts with a letter, then alnum/underscore. */
export const SGACL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

export interface SgaclSpec {
  name: string
  description: string
  ipVersion: string
  aclContent: string
}

export function normalizeIpVersion(value: unknown): string {
  const s = String(value ?? '').trim().toUpperCase()
  return IP_VERSIONS.has(s) ? s : DEFAULT_IP_VERSION
}

/** Normalize the multi-line ACL textarea into ISE's single newline-joined `aclcontent` string. */
export function normalizeAclContent(value: unknown): string {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

export function specFromItem(item: CanvasItemSnapshot): SgaclSpec {
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
    ipVersion: normalizeIpVersion(item.fields.ip_version),
    aclContent: normalizeAclContent(item.fields.acl_content),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): SgaclSpec[] {
  return items.map(specFromItem)
}

export function toSgaclBody(spec: SgaclSpec): Omit<Sgacl, 'id' | 'link'> {
  return { name: spec.name, description: spec.description, ipVersion: spec.ipVersion as Sgacl['ipVersion'], aclcontent: spec.aclContent }
}
