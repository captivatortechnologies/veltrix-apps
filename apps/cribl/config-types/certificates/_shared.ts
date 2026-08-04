// Cribl Certificates config type — TLS certificate/key pairs over
// /api/v1/m/<group>/system/certificates. Shares the generic record CRUD
// engine in lib/criblRecordEntities. A Certificate is a flat named record:
// { id, cert, privKey, passphrase, ca, description }.
//
// ⚠ WRITE-ONLY SECRETS: `privKey` and `passphrase` are never echoed back by
// Cribl (its own docs state "Responses do not include the privKey value"), so
// each is sent ONLY when its canvas field is non-blank, is never captured into
// rollbackData, and is never drift-checked (see lib/criblRecordEntities'
// `sensitiveKeys`). Same trade-off as apps/cisco-ise's internal-users
// write-only password. `cert`/`ca` are public material and round-trip / diff
// normally.

import type { RecordDescriptor, RecordSpec } from '../../lib/criblRecordEntities'

export const CERTIFICATE: RecordDescriptor = {
  resource: 'system/certificates',
  kind: 'certificate',
  Kind: 'Certificate',
  sensitiveKeys: ['privKey', 'passphrase'],
}

export function buildCertificateRecord(fields: Record<string, unknown>, settings: Record<string, unknown>): RecordSpec {
  void settings
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  const cert = String(fields.cert ?? '').trim()
  if (!cert) return { id, body: null, error: 'cert is empty — provide the certificate in PEM format.' }

  const body: Record<string, unknown> = { id, cert }
  const privKey = String(fields.priv_key ?? '')
  if (privKey) body.privKey = privKey
  const passphrase = String(fields.passphrase ?? '')
  if (passphrase) body.passphrase = passphrase
  const ca = String(fields.ca ?? '').trim()
  if (ca) body.ca = ca
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description

  return { id, body, error: null }
}
