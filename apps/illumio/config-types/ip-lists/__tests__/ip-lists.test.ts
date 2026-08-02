import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate, { extractIpListSpecs, isValidCidr, isValidFromIp, isValidIpv4, MAX_NAME_LENGTH } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/driftDetect/healthCheck call the live PCE over node:https
 * inside illumioApi, which is impractical to mock here. Tests focus on
 * validate.ts, which is network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Public Internet', ipRangesJson: '[{"fromIp":"0.0.0.0/0"}]' }

test('validate accepts a good IP list with a CIDR range', () => {
  const res = validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts an IP list with only FQDNs', () => {
  const res = validate(ctxOf([{ name: 'Cloud APIs', fqdnsJson: '[{"fqdn":"*.example.com"}]' }]))
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

test('validate rejects an IP list with neither IP ranges nor FQDNs', () => {
  const res = validate(ctxOf([{ name: 'Empty' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_members'))
})

test('validate rejects invalid JSON in ipRangesJson', () => {
  const res = validate(ctxOf([{ name: 'Bad', ipRangesJson: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_json' && e.field === 'items[0].ipRangesJson'))
})

test('validate rejects an ip_ranges entry missing from_ip', () => {
  const res = validate(ctxOf([{ name: 'Bad', ipRangesJson: '[{"toIp":"10.0.0.5"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].ipRangesJson[0].fromIp' && e.code === 'required'))
})

test('validate rejects an invalid from_ip', () => {
  const res = validate(ctxOf([{ name: 'Bad', ipRangesJson: '[{"fromIp":"999.0.0.0/8"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_ip'))
})

test('validate rejects an fqdns entry missing fqdn', () => {
  const res = validate(ctxOf([{ name: 'Bad', fqdnsJson: '[{"description":"x"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].fqdnsJson[0].fqdn' && e.code === 'required'))
})

test('extractIpListSpecs parses ip_ranges and fqdns JSON', () => {
  const specs = extractIpListSpecs({
    items: [
      {
        id: 'i1',
        name: 'A',
        fields: {
          name: 'A',
          ipRangesJson: '[{"fromIp":"10.0.0.0/8","exclusion":true}]',
          fqdnsJson: '[{"fqdn":"a.example.com"}]',
        },
      },
    ],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].ipRanges[0].fromIp, '10.0.0.0/8')
  assert.equal(specs[0].ipRanges[0].exclusion, true)
  assert.equal(specs[0].fqdns[0].fqdn, 'a.example.com')
})

test('isValidIpv4 / isValidCidr / isValidFromIp', () => {
  assert.equal(isValidIpv4('10.0.0.1'), true)
  assert.equal(isValidIpv4('10.0.0.1/24'), false)
  assert.equal(isValidCidr('10.0.0.0/24'), true)
  assert.equal(isValidCidr('10.0.0.0/33'), false)
  assert.equal(isValidFromIp('10.0.0.1'), true)
  assert.equal(isValidFromIp('10.0.0.0/24'), true)
  assert.equal(isValidFromIp('not-an-ip'), false)
})
