import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, portsApplicable, toPortForwardCreateBody, snapshotPortForward, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `pf-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validPf = {
  interface: 'wan',
  ipprotocol: 'inet',
  protocol: 'tcp',
  source: 'any',
  destination: 'wan:ip',
  destination_port: '8443',
  target: '10.0.0.5',
  local_port: '443',
  descr: 'HTTPS to internal web server',
}

// --- validate ------------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires an interface', async () => {
  const res = await validate(ctxOf([{ ...validPf, interface: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INTERFACE'))
})

test('validate requires a recognized protocol', async () => {
  const res = await validate(ctxOf([{ ...validPf, protocol: 'bogus' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate requires source and destination', async () => {
  const res = await validate(ctxOf([{ ...validPf, source: '', destination: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SOURCE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESTINATION'))
})

test('validate requires a target and rejects a value with no valid shape at all', async () => {
  const noTarget = await validate(ctxOf([{ ...validPf, target: '' }]))
  assert.ok(noTarget.errors.some((e) => e.code === 'EMPTY_TARGET'))

  // Something with no valid shape whatsoever (not an IP, not a token, not
  // an interface:ip) is rejected. A BARE token like "wan" is deliberately
  // NOT rejected here — an alias name and an interface name share the exact
  // same shape (see isValidNatTarget's doc), so this schema-only check
  // cannot honestly distinguish "wan the interface" (invalid) from "wan the
  // alias" (valid) without a live lookup; the REST API package is authoritative.
  const malformed = await validate(ctxOf([{ ...validPf, target: 'not a valid target!' }]))
  assert.ok(malformed.errors.some((e) => e.code === 'INVALID_TARGET'))
})

test('validate rejects "any" as a target (NAT targets do not accept it, unlike source/destination)', async () => {
  const anyTarget = await validate(ctxOf([{ ...validPf, target: 'any' }]))
  assert.ok(anyTarget.errors.some((e) => e.code === 'INVALID_TARGET'))
})

test('validate accepts a target that is an IP, an alias-shaped token, or an interface :ip modifier', async () => {
  const ip = await validate(ctxOf([{ ...validPf, target: '10.0.0.5' }]))
  assert.equal(ip.errors.some((e) => e.code === 'INVALID_TARGET'), false)

  const alias = await validate(ctxOf([{ ...validPf, target: 'INTERNAL_WEB_SERVER' }]))
  assert.equal(alias.errors.some((e) => e.code === 'INVALID_TARGET'), false)

  const ifIp = await validate(ctxOf([{ ...validPf, target: 'lan:ip' }]))
  assert.equal(ifIp.errors.some((e) => e.code === 'INVALID_TARGET'), false)
})

test('validate requires a local port', async () => {
  const res = await validate(ctxOf([{ ...validPf, local_port: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LOCAL_PORT'))
})

test('validate rejects a malformed destination port', async () => {
  const res = await validate(ctxOf([{ ...validPf, destination_port: 'not-a-port!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DESTINATION_PORT'))
})

test('validate warns on ports set with a non-port protocol', async () => {
  const res = await validate(ctxOf([{ ...validPf, protocol: 'icmp', destination_port: '8443' }]))
  assert.ok(res.warnings.some((w) => w.code === 'PORT_IGNORED'))
})

test('validate warns on a custom associated_rule_id (cannot verify it live)', async () => {
  const res = await validate(ctxOf([{ ...validPf, associated_rule_id: 'abc123' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'CUSTOM_ASSOCIATED_RULE_ID'))
})

test('validate accepts the "new" and "pass" associated_rule_id keywords without a warning', async () => {
  const newRes = await validate(ctxOf([{ ...validPf, associated_rule_id: 'new' }]))
  assert.equal(newRes.warnings.some((w) => w.code === 'CUSTOM_ASSOCIATED_RULE_ID'), false)
  const passRes = await validate(ctxOf([{ ...validPf, associated_rule_id: 'pass' }]))
  assert.equal(passRes.warnings.some((w) => w.code === 'CUSTOM_ASSOCIATED_RULE_ID'), false)
})

test('validate accepts a well-formed port forward', async () => {
  const res = await validate(ctxOf([validPf]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validPf, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

// --- _shared -------------------------------------------------------------------

test('specFromItem uses the canvas item id as itemId (port-forward identity)', () => {
  const spec = specFromItem({ id: 'pf-abc', name: 'x', fields: validPf })
  assert.equal(spec.itemId, 'pf-abc')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validPf, validPf]))
  assert.equal(specs.length, 2)
})

test('portsApplicable is true only for tcp/udp/tcp-udp', () => {
  assert.equal(portsApplicable('tcp'), true)
  assert.equal(portsApplicable('any'), false)
  assert.equal(portsApplicable('icmp'), false)
})

test('toPortForwardCreateBody carries ports only when the protocol applies', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validPf })
  const body = toPortForwardCreateBody(spec)
  assert.equal(body.destination_port, '8443')

  const icmpSpec = specFromItem({ id: 'i', name: 'x', fields: { ...validPf, protocol: 'icmp', destination_port: '8443' } })
  const icmpBody = toPortForwardCreateBody(icmpSpec)
  assert.equal(icmpBody.destination_port, null)
})

test('snapshotPortForward carries every managed field, no id', () => {
  const snap = snapshotPortForward({
    id: 4,
    interface: 'wan',
    protocol: 'tcp',
    source: 'any',
    destination: 'wan:ip',
    target: '10.0.0.5',
    local_port: '443',
  }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.interface, 'wan')
  assert.equal(snap.local_port, '443')
})
