import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { CERTIFICATE, buildCertificateRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

// NOTE: deliberately not a real PEM block — the platform's app-packaging
// validator scans every shipped file (test fixtures included) for
// private-key-block patterns.
const good = {
  id: 'my-cert',
  worker_group: 'default',
  cert: 'FAKE-CERT-PEM-CONTENT-FOR-TESTING-ONLY',
  priv_key: 'FAKE-PRIVATE-KEY-PEM-CONTENT-FOR-TESTING-ONLY',
}

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an empty cert', async () => {
  const res = await validate(ctxOf([{ ...good, cert: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate warns when priv_key is blank', async () => {
  const res = await validate(ctxOf([{ ...good, priv_key: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PRIV_KEY_BLANK'))
})

test('validate accepts a good certificate', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('buildCertificateRecord includes priv_key/passphrase only when non-blank', () => {
  const spec = buildCertificateRecord(good, {})
  assert.equal(spec.error, null)
  assert.equal(spec.body?.privKey, good.priv_key)
  assert.equal(spec.body?.passphrase, undefined)
})

test('CERTIFICATE declares privKey/passphrase as sensitiveKeys', () => {
  assert.equal(CERTIFICATE.resource, 'system/certificates')
  assert.deepEqual(CERTIFICATE.sensitiveKeys, ['privKey', 'passphrase'])
})
