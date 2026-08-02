import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate, { extractServiceSpecs, validateServicePort, MAX_NAME_LENGTH } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'HTTPS', servicePortsJson: '[{"proto":6,"port":443}]' }

test('validate accepts a good TCP service', () => {
  const res = validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a port range', () => {
  const res = validate(ctxOf([{ name: 'Range', servicePortsJson: '[{"proto":17,"port":500,"toPort":600}]' }]))
  assert.equal(res.valid, true)
})

test('validate accepts an ICMP service', () => {
  const res = validate(ctxOf([{ name: 'Ping', servicePortsJson: '[{"proto":1,"icmpType":8,"icmpCode":0}]' }]))
  assert.equal(res.valid, true)
})

test('validate accepts a protocol-only service (e.g. GRE)', () => {
  const res = validate(ctxOf([{ name: 'GRE', servicePortsJson: '[{"proto":47}]' }]))
  assert.equal(res.valid, true)
})

test('validate requires a name', () => {
  const res = validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].name' && e.code === 'required'))
})

test('validate rejects a name longer than 255 characters', () => {
  const res = validate(ctxOf([{ ...good, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long'))
})

test('validate rejects a duplicate name', () => {
  const res = validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate requires at least one service port', () => {
  const res = validate(ctxOf([{ name: 'Empty' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_ports'))
})

test('validate rejects invalid JSON', () => {
  const res = validate(ctxOf([{ name: 'Bad', servicePortsJson: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_json'))
})

test('validate rejects icmp fields on a TCP service', () => {
  const res = validate(ctxOf([{ name: 'Bad', servicePortsJson: '[{"proto":6,"port":443,"icmpType":8}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_port'))
})

test('validate rejects port fields on an ICMP service', () => {
  const res = validate(ctxOf([{ name: 'Bad', servicePortsJson: '[{"proto":1,"port":443}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_port'))
})

test('validate rejects toPort without port', () => {
  const res = validate(ctxOf([{ name: 'Bad', servicePortsJson: '[{"proto":6,"toPort":443}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_port'))
})

test('validate rejects toPort <= port', () => {
  const res = validate(ctxOf([{ name: 'Bad', servicePortsJson: '[{"proto":6,"port":500,"toPort":500}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_port'))
})

test('validate rejects icmpCode without icmpType', () => {
  const res = validate(ctxOf([{ name: 'Bad', servicePortsJson: '[{"proto":1,"icmpCode":0}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_port'))
})

test('validate rejects an out-of-range proto', () => {
  const res = validate(ctxOf([{ name: 'Bad', servicePortsJson: '[{"proto":999}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_port'))
})

test('extractServiceSpecs parses service_ports JSON', () => {
  const specs = extractServiceSpecs({
    items: [{ id: 'i1', name: 'A', fields: { name: 'A', servicePortsJson: '[{"proto":6,"port":22}]' } }],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].servicePorts[0].proto, 6)
  assert.equal(specs[0].servicePorts[0].port, 22)
})

test('validateServicePort accepts proto -1 (all services)', () => {
  assert.equal(validateServicePort({ proto: -1 }), null)
})
