// Shared helpers for the Allowed Protocols config type (validate + deploy +
// rollback + drift). Field shapes verified against the official Cisco ISE
// Ansible collection (github.com/CiscoISE/ansible-ise,
// plugins/modules/allowed_protocols.py) — confirmed create (POST) support and
// the wrapper key "Allowedprotocols". SCOPED to top-level flags only — the
// real schema also nests eapFast/eapTls/eapTtls/peap/teap sub-objects (a
// dozen+ fields each), intentionally not implemented here.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { AllowedProtocols } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000

const BOOL_FIELD_KEYS = [
  'allow_pap_ascii',
  'allow_chap',
  'allow_ms_chap_v1',
  'allow_ms_chap_v2',
  'allow_eap_md5',
  'allow_leap',
  'allow_eap_tls',
  'allow_peap',
  'allow_eap_ttls',
  'allow_eap_fast',
  'allow_teap',
  'process_host_lookup',
] as const

export interface AllowedProtocolsSpec {
  name: string
  description: string
  allowPapAscii: boolean
  allowChap: boolean
  allowMsChapV1: boolean
  allowMsChapV2: boolean
  allowEapMd5: boolean
  allowLeap: boolean
  allowEapTls: boolean
  allowPeap: boolean
  allowEapTtls: boolean
  allowEapFast: boolean
  allowTeap: boolean
  preferredEapProtocol: string
  processHostLookup: boolean
}

function bool(fields: Record<string, unknown>, key: (typeof BOOL_FIELD_KEYS)[number], fallback: boolean): boolean {
  const v = fields[key]
  return v === undefined || v === null ? fallback : v === true
}

export function specFromItem(item: CanvasItemSnapshot): AllowedProtocolsSpec {
  const f = item.fields
  return {
    name: String(f.name ?? '').trim(),
    description: String(f.description ?? '').trim(),
    allowPapAscii: bool(f, 'allow_pap_ascii', true),
    allowChap: bool(f, 'allow_chap', false),
    allowMsChapV1: bool(f, 'allow_ms_chap_v1', false),
    allowMsChapV2: bool(f, 'allow_ms_chap_v2', false),
    allowEapMd5: bool(f, 'allow_eap_md5', true),
    allowLeap: bool(f, 'allow_leap', false),
    allowEapTls: bool(f, 'allow_eap_tls', true),
    allowPeap: bool(f, 'allow_peap', true),
    allowEapTtls: bool(f, 'allow_eap_ttls', true),
    allowEapFast: bool(f, 'allow_eap_fast', true),
    allowTeap: bool(f, 'allow_teap', false),
    preferredEapProtocol: String(f.preferred_eap_protocol ?? '').trim(),
    processHostLookup: bool(f, 'process_host_lookup', true),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): AllowedProtocolsSpec[] {
  return items.map(specFromItem)
}

export function toAllowedProtocolsBody(spec: AllowedProtocolsSpec): Omit<AllowedProtocols, 'id' | 'link'> {
  const body: Omit<AllowedProtocols, 'id' | 'link'> = {
    name: spec.name,
    description: spec.description,
    allowPapAscii: spec.allowPapAscii,
    allowChap: spec.allowChap,
    allowMsChapV1: spec.allowMsChapV1,
    allowMsChapV2: spec.allowMsChapV2,
    allowEapMd5: spec.allowEapMd5,
    allowLeap: spec.allowLeap,
    allowEapTls: spec.allowEapTls,
    allowPeap: spec.allowPeap,
    allowEapTtls: spec.allowEapTtls,
    allowEapFast: spec.allowEapFast,
    allowTeap: spec.allowTeap,
    processHostLookup: spec.processHostLookup,
  }
  if (spec.preferredEapProtocol) body.preferredEapProtocol = spec.preferredEapProtocol
  return body
}
