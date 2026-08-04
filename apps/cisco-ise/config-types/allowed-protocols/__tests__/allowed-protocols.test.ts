import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toAllowedProtocolsBody, MAX_NAME_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Default Network Access', allow_peap: true }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a name over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate warns when every authentication method is disabled', async () => {
  const res = await validate(
    ctxOf([
      {
        name: 'Nothing Allowed',
        allow_pap_ascii: false,
        allow_chap: false,
        allow_ms_chap_v1: false,
        allow_ms_chap_v2: false,
        allow_eap_md5: false,
        allow_leap: false,
        allow_eap_tls: false,
        allow_peap: false,
        allow_eap_ttls: false,
        allow_eap_fast: false,
        allow_teap: false,
      },
    ]),
  )
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_METHOD_ENABLED'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed service', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('specFromItem applies sensible defaults for unset flags', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: 'x' } })
  assert.equal(spec.allowPapAscii, true)
  assert.equal(spec.allowChap, false)
  assert.equal(spec.allowEapTls, true)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'Default Network Access')
})

test('toAllowedProtocolsBody omits preferredEapProtocol when blank', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toAllowedProtocolsBody(spec)
  assert.equal(body.preferredEapProtocol, undefined)
  assert.equal(body.allowPeap, true)
})

test('toAllowedProtocolsBody includes preferredEapProtocol when set', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { ...good, preferred_eap_protocol: 'PEAP' } })
  const body = toAllowedProtocolsBody(spec)
  assert.equal(body.preferredEapProtocol, 'PEAP')
})
