import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, domainOverrideKey, isValidOverrideDomain, toDomainOverrideBody, snapshotDomainOverride, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `override-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validOverride = { domain: 'internal.example.com', ip: '10.0.0.53', descr: 'Internal DNS' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a domain', async () => {
  const res = await validate(ctxOf([{ ...validOverride, domain: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DOMAIN'))
})

test('validate rejects a malformed domain', async () => {
  const res = await validate(ctxOf([{ ...validOverride, domain: 'not valid!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DOMAIN'))
})

test('validate rejects a duplicate domain (case-insensitive)', async () => {
  const res = await validate(ctxOf([validOverride, { ...validOverride, domain: 'INTERNAL.EXAMPLE.COM' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_DOMAIN'))
})

test('validate requires a valid upstream IP', async () => {
  const empty = await validate(ctxOf([{ ...validOverride, ip: '' }]))
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_IP'))
  const invalid = await validate(ctxOf([{ ...validOverride, ip: 'not-an-ip' }]))
  assert.ok(invalid.errors.some((e) => e.code === 'INVALID_IP'))
})

test('validate requires tls_hostname when forward_tls_upstream is enabled', async () => {
  const res = await validate(ctxOf([{ ...validOverride, forward_tls_upstream: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TLS_HOSTNAME'))
})

test('validate warns when tls_hostname is set without forward_tls_upstream', async () => {
  const res = await validate(ctxOf([{ ...validOverride, tls_hostname: 'dns.example.com' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'TLS_HOSTNAME_IGNORED'))
})

test('validate accepts a well-formed domain override', async () => {
  const res = await validate(ctxOf([validOverride]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a well-formed TLS-forwarding override', async () => {
  const res = await validate(ctxOf([{ ...validOverride, forward_tls_upstream: true, tls_hostname: 'dns.example.com' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validOverride, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('domainOverrideKey lowercases and trims', () => {
  assert.equal(domainOverrideKey('  Example.COM '), 'example.com')
})

test('isValidOverrideDomain accepts an FQDN and a bare domain label', () => {
  assert.equal(isValidOverrideDomain('internal.example.com'), true)
  assert.equal(isValidOverrideDomain('localdomain'), true)
  assert.equal(isValidOverrideDomain('not a domain!'), false)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validOverride, validOverride]))
  assert.equal(specs.length, 2)
})

test('toDomainOverrideBody clears tls_hostname unless forward_tls_upstream is set', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: { ...validOverride, tls_hostname: 'dns.example.com' } })
  assert.equal(toDomainOverrideBody(spec).tls_hostname, '')

  const tlsSpec = specFromItem({ id: 'i', name: 'x', fields: { ...validOverride, forward_tls_upstream: true, tls_hostname: 'dns.example.com' } })
  assert.equal(toDomainOverrideBody(tlsSpec).tls_hostname, 'dns.example.com')
})

test('snapshotDomainOverride never includes id', () => {
  const snap = snapshotDomainOverride({ id: 2, domain: 'internal.example.com', ip: '10.0.0.53' }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.domain, 'internal.example.com')
})
