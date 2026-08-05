import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildFirewallPolicyBody, diffFirewallPolicy, extractFirewallPolicySpecs, parseNetworkRules } from '../_shared'
import type { PipelineContext, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { AquaFirewallPolicy } from '../../../lib/aquasec'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  return { items: list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields })) } as unknown as CanvasSnapshot
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = {
  name: 'prod-network-lockdown',
  blockIcmpPing: true,
  blockMetadataService: true,
  inboundNetworksJson: JSON.stringify([{ allow: false, resourceType: 'anywhere', portRange: '0-1000' }]),
  outboundNetworksJson: JSON.stringify([{ allow: false, resourceType: 'custom', portRange: '443', resource: '192.168.1.5/32' }]),
}

test('parseNetworkRules accepts a well-formed rule array', () => {
  const { rules, error } = parseNetworkRules(good.inboundNetworksJson)
  assert.equal(error, undefined)
  assert.deepEqual(rules, [{ allow: false, resource_type: 'anywhere', port_range: '0-1000', resource: undefined }])
})

test('parseNetworkRules treats blank input as an empty (valid) list', () => {
  assert.deepEqual(parseNetworkRules(''), { rules: [] })
})

test('parseNetworkRules rejects invalid JSON', () => {
  const { error } = parseNetworkRules('{not json')
  assert.ok(error?.includes('valid JSON'))
})

test('parseNetworkRules rejects a non-array', () => {
  const { error } = parseNetworkRules('{}')
  assert.ok(error?.includes('array'))
})

test('parseNetworkRules requires resource when resourceType is custom', () => {
  const { error } = parseNetworkRules(JSON.stringify([{ allow: true, resourceType: 'custom', portRange: '80' }]))
  assert.ok(error?.includes('resource'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects malformed inbound JSON', async () => {
  const res = await validate(ctxOf([{ ...good, inboundNetworksJson: '{broken' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_INBOUND_JSON'))
})

test('validate warns on a policy with no rules and no baseline protections', async () => {
  const res = await validate(ctxOf([{ name: 'noop', blockIcmpPing: false, blockMetadataService: false, inboundNetworksJson: '', outboundNetworksJson: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_OP_POLICY'))
})

test('buildFirewallPolicyBody maps a spec to the Aqua wire shape', () => {
  const [spec] = extractFirewallPolicySpecs(canvasOf([good]))
  const body = buildFirewallPolicyBody(spec)
  assert.equal(body.name, 'prod-network-lockdown')
  assert.equal(body.block_icmp_ping, true)
  assert.deepEqual(body.inbound_networks, [{ allow: false, resource_type: 'anywhere', port_range: '0-1000', resource: undefined }])
})

test('diffFirewallPolicy reports no drift when the live policy matches the spec', () => {
  const [spec] = extractFirewallPolicySpecs(canvasOf([good]))
  const live = buildFirewallPolicyBody(spec) as AquaFirewallPolicy
  assert.deepEqual(diffFirewallPolicy(spec, live), [])
})

test('diffFirewallPolicy flags a changed rule set as critical', () => {
  const [spec] = extractFirewallPolicySpecs(canvasOf([good]))
  const live: AquaFirewallPolicy = { ...(buildFirewallPolicyBody(spec) as AquaFirewallPolicy), inbound_networks: [] }
  const diffs = diffFirewallPolicy(spec, live)
  const found = diffs.find((d) => d.field === 'prod-network-lockdown.inboundNetworks')
  assert.ok(found)
  assert.equal(found?.severity, 'critical')
})
