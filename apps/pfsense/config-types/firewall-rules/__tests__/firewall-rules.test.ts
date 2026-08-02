import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, portsApplicable, toRuleCreateBody, toRuleUpdateBody, snapshotRule, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `rule-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validRule = { type: 'pass', interface: ['wan'], ipprotocol: 'inet', source: 'any', destination: '10.0.0.0/24', descr: 'allow LAN out' }

// --- validate ------------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a type', async () => {
  const res = await validate(ctxOf([{ ...validRule, type: undefined }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate requires at least one interface', async () => {
  const res = await validate(ctxOf([{ ...validRule, interface: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INTERFACE'))
})

test('validate rejects more than one interface unless floating', async () => {
  const res = await validate(ctxOf([{ ...validRule, interface: ['wan', 'lan'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MULTIPLE_INTERFACE_WITHOUT_FLOATING'))
})

test('validate allows multiple interfaces when floating', async () => {
  const res = await validate(ctxOf([{ ...validRule, interface: ['wan', 'lan'], floating: true }]))
  assert.equal(res.errors.some((e) => e.code === 'MULTIPLE_INTERFACE_WITHOUT_FLOATING'), false)
})

test('validate rejects an unrecognized protocol', async () => {
  const res = await validate(ctxOf([{ ...validRule, protocol: 'bogus' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate requires source and destination', async () => {
  const res = await validate(ctxOf([{ ...validRule, source: '', destination: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SOURCE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESTINATION'))
})

test('validate rejects an invalid source value', async () => {
  const res = await validate(ctxOf([{ ...validRule, source: '!!!not valid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SOURCE'))
})

test('validate rejects "!any" (invert on any is explicitly invalid)', async () => {
  const res = await validate(ctxOf([{ ...validRule, source: '!any' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SOURCE'))
})

test('validate accepts a well-formed rule with a port protocol and ports', async () => {
  const res = await validate(ctxOf([{ ...validRule, protocol: 'tcp', destination_port: '443' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a malformed port', async () => {
  const res = await validate(ctxOf([{ ...validRule, protocol: 'tcp', destination_port: 'not-a-port!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DESTINATION_PORT'))
})

test('validate warns when a port is set but protocol does not use ports', async () => {
  const res = await validate(ctxOf([{ ...validRule, protocol: 'icmp', destination_port: '443' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PORT_IGNORED'))
})

test('validate warns when direction/quick are set without floating', async () => {
  const res = await validate(ctxOf([{ ...validRule, quick: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'FLOATING_ONLY_FIELD_IGNORED'))
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validRule, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns (does not error) on a missing description', async () => {
  const res = await validate(ctxOf([{ ...validRule, descr: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_DESCRIPTION'))
})

// --- _shared -------------------------------------------------------------------

test('specFromItem uses the canvas item id as itemId (rule identity)', () => {
  const spec = specFromItem({ id: 'abc-123', name: 'x', fields: validRule })
  assert.equal(spec.itemId, 'abc-123')
})

test('specFromItem parses position only when a valid non-negative integer', () => {
  assert.equal(specFromItem({ id: 'i', name: 'x', fields: { ...validRule, position: 3 } }).position, 3)
  assert.equal(specFromItem({ id: 'i', name: 'x', fields: { ...validRule, position: -1 } }).position, null)
  assert.equal(specFromItem({ id: 'i', name: 'x', fields: { ...validRule, position: 'abc' } }).position, null)
  assert.equal(specFromItem({ id: 'i', name: 'x', fields: validRule }).position, null)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validRule, validRule]))
  assert.equal(specs.length, 2)
})

test('portsApplicable is true only for tcp/udp/tcp-udp', () => {
  assert.equal(portsApplicable('tcp'), true)
  assert.equal(portsApplicable('udp'), true)
  assert.equal(portsApplicable('tcp/udp'), true)
  assert.equal(portsApplicable('icmp'), false)
  assert.equal(portsApplicable(''), false)
})

test('toRuleCreateBody maps null protocol/ports when unset', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validRule })
  const body = toRuleCreateBody(spec)
  assert.equal(body.protocol, null)
  assert.equal(body.source_port, null)
  assert.equal(body.destination_port, null)
  assert.equal(body.floating, false)
})

test('toRuleCreateBody carries ports only when the protocol applies', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: { ...validRule, protocol: 'tcp', destination_port: '443' } })
  const body = toRuleCreateBody(spec)
  assert.equal(body.destination_port, '443')
})

test('toRuleCreateBody zeroes quick/direction unless floating', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: { ...validRule, quick: true, direction: 'in' } })
  const body = toRuleCreateBody(spec)
  assert.equal(body.quick, false)
  assert.equal(body.direction, 'any')
})

test('toRuleUpdateBody never includes floating', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validRule })
  const body = toRuleUpdateBody(spec) as Record<string, unknown>
  assert.equal('floating' in body, false)
})

test('snapshotRule never includes id or floating', () => {
  const snap = snapshotRule({
    id: 5,
    type: 'pass',
    interface: ['wan'],
    floating: false,
    ipprotocol: 'inet',
    protocol: null,
    source: 'any',
    destination: '10.0.0.0/24',
  }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal('floating' in snap, false)
  assert.equal(snap.type, 'pass')
})
