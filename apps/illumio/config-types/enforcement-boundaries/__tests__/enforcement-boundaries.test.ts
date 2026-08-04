import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractEnforcementBoundarySpecs,
  providerConsumerShapeError,
  resolveProviderConsumer,
  resolveIngressServices,
  buildBoundaryBody,
  ALL_WORKLOADS_ACTOR,
  labelIdentity,
  type Resolvers,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Deny-SSH-from-Internet',
  providersJson: '[{"allWorkloads":true}]',
  consumersJson: '[{"ipList":"Public Internet"}]',
  servicesJson: '[{"name":"SSH"}]',
}

test('validate accepts a good enforcement boundary', () => {
  const res = validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate requires a name', () => {
  const res = validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].name' && e.code === 'required'))
})

test('validate rejects a duplicate name', () => {
  const res = validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate requires at least one provider', () => {
  const res = validate(ctxOf([{ ...good, providersJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_providers'))
})

test('validate requires at least one consumer', () => {
  const res = validate(ctxOf([{ ...good, consumersJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_consumers'))
})

test('validate requires at least one service', () => {
  const res = validate(ctxOf([{ ...good, servicesJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_services'))
})

test('validate rejects invalid JSON', () => {
  const res = validate(ctxOf([{ ...good, providersJson: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_json'))
})

test('validate rejects a provider with zero or multiple actor kinds', () => {
  const zero = validate(ctxOf([{ ...good, providersJson: '[{}]' }]))
  assert.equal(zero.valid, false)
  assert.ok(zero.errors.some((e) => e.code === 'invalid_actor'))

  const two = validate(ctxOf([{ ...good, providersJson: '[{"allWorkloads":true,"ipList":"X"}]' }]))
  assert.equal(two.valid, false)
  assert.ok(two.errors.some((e) => e.code === 'invalid_actor'))
})

test('extractEnforcementBoundarySpecs parses providers/consumers/services', () => {
  const specs = extractEnforcementBoundarySpecs({ items: [{ id: 'i1', name: 'A', fields: good }] } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].providers[0].allWorkloads, true)
  assert.equal(specs[0].consumers[0].ipList, 'Public Internet')
  assert.equal(specs[0].services[0].name, 'SSH')
  assert.equal(specs[0].enabled, true)
})

function resolversOf(labels: Array<[string, string]>, ipLists: string[], services: string[]): Resolvers {
  return {
    labelHrefByIdentity: new Map(labels.map(([k, v]) => [labelIdentity(k, v), `/orgs/1/labels/${k}-${v}`])),
    ipListHrefByName: new Map(ipLists.map((n) => [n.toLowerCase(), `/orgs/1/sec_policy/draft/ip_lists/${n}`])),
    serviceHrefByName: new Map(services.map((n) => [n.toLowerCase(), `/orgs/1/sec_policy/draft/services/${n}`])),
  }
}

test('resolveProviderConsumer resolves allWorkloads to the ams actor', () => {
  assert.deepEqual(resolveProviderConsumer({ allWorkloads: true }, resolversOf([], [], []), 'a provider'), { actors: ALL_WORKLOADS_ACTOR })
})

test('resolveProviderConsumer FAILS CLOSED on an unresolved label', () => {
  assert.throws(() => resolveProviderConsumer({ label: { key: 'role', value: 'R-Ghost' } }, resolversOf([], [], []), 'a consumer'), /does not exist/)
})

test('resolveIngressServices FAILS CLOSED on an unresolved service', () => {
  const resolvers = resolversOf([], [], ['SSH'])
  assert.throws(() => resolveIngressServices([{ name: 'Ghost' }], resolvers), /does not exist/)
  assert.deepEqual(resolveIngressServices([{ name: 'SSH' }], resolvers), [{ href: '/orgs/1/sec_policy/draft/services/SSH' }])
})

test('buildBoundaryBody FAILS CLOSED when any reference is unresolved', () => {
  const resolvers = resolversOf([], ['Public Internet'], [])
  assert.throws(
    () =>
      buildBoundaryBody(
        { name: 'X', enabled: true, providers: [{ allWorkloads: true }], consumers: [{ ipList: 'Public Internet' }], services: [{ name: 'Ghost' }] },
        resolvers,
      ),
    /does not exist/,
  )
})

test('buildBoundaryBody succeeds and shapes the PCE body correctly', () => {
  const resolvers = resolversOf([], ['Public Internet'], ['SSH'])
  const body = buildBoundaryBody(
    { name: 'X', enabled: true, providers: [{ allWorkloads: true }], consumers: [{ ipList: 'Public Internet' }], services: [{ name: 'SSH' }] },
    resolvers,
  )
  assert.deepEqual(body, {
    name: 'X',
    enabled: true,
    providers: [{ actors: ALL_WORKLOADS_ACTOR }],
    consumers: [{ ip_list: { href: '/orgs/1/sec_policy/draft/ip_lists/Public Internet' } }],
    ingress_services: [{ href: '/orgs/1/sec_policy/draft/services/SSH' }],
  })
})

test('providerConsumerShapeError requires exactly one actor kind', () => {
  assert.equal(providerConsumerShapeError({ allWorkloads: true }, 'a provider'), null)
  assert.ok(providerConsumerShapeError({}, 'a provider'))
  assert.ok(providerConsumerShapeError({ allWorkloads: true, ipList: 'X' }, 'a provider'))
})
