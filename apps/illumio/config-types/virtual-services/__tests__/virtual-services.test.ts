import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate, { extractVirtualServiceSpecs, validateServicePort, MAX_NAME_LENGTH } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodWithPorts = { name: 'Payments API', applyTo: 'host_only', servicePortsJson: '[{"proto":6,"port":443}]' }
const goodWithService = { name: 'Web API', applyTo: 'host_only', serviceName: 'HTTPS' }

test('validate accepts a virtual service with inline service ports', () => {
  const res = validate(ctxOf([goodWithPorts]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a virtual service referencing an existing service', () => {
  const res = validate(ctxOf([goodWithService]))
  assert.equal(res.valid, true)
})

test('validate requires a name', () => {
  const res = validate(ctxOf([{ ...goodWithPorts, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].name' && e.code === 'required'))
})

test('validate rejects a name longer than 255 characters', () => {
  const res = validate(ctxOf([{ ...goodWithPorts, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long'))
})

test('validate rejects a duplicate name', () => {
  const res = validate(ctxOf([goodWithPorts, { ...goodWithPorts }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate rejects an invalid applyTo', () => {
  const res = validate(ctxOf([{ ...goodWithPorts, applyTo: 'everywhere' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_apply_to'))
})

test('validate rejects setting neither serviceName nor servicePorts', () => {
  const res = validate(ctxOf([{ name: 'Neither', applyTo: 'host_only' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'exactly_one_service'))
})

test('validate rejects setting both serviceName and servicePorts', () => {
  const res = validate(ctxOf([{ ...goodWithPorts, serviceName: 'HTTPS' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'exactly_one_service'))
})

test('validate rejects an ICMP proto in inline service ports', () => {
  const res = validate(ctxOf([{ name: 'Bad', applyTo: 'host_only', servicePortsJson: '[{"proto":1}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_port'))
})

test('validate rejects invalid JSON in labelsJson', () => {
  const res = validate(ctxOf([{ ...goodWithService, labelsJson: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_json'))
})

test('extractVirtualServiceSpecs parses ip overrides tags and label refs', () => {
  const specs = extractVirtualServiceSpecs({
    items: [
      {
        id: 'i1',
        name: 'A',
        fields: { ...goodWithService, labelsJson: '[{"key":"app","value":"Payments"}]', ipOverrides: ['10.0.0.1', '10.0.0.2'] },
      },
    ],
  } as unknown as PipelineContext['canvas'])
  assert.deepEqual(specs[0].ipOverrides, ['10.0.0.1', '10.0.0.2'])
  assert.equal(specs[0].labels[0].value, 'Payments')
})

test('validateServicePort rejects a range where toPort <= port', () => {
  assert.ok(validateServicePort({ proto: 6, port: 500, toPort: 500 }))
  assert.equal(validateServicePort({ proto: 6, port: 500, toPort: 600 }), null)
})
