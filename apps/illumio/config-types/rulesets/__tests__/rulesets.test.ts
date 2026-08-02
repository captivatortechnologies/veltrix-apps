import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractRuleSetSpecs,
  parseLabelRefArray,
  parseRulesJson,
  providerConsumerShapeError,
  resolveProviderConsumer,
  resolveIngressServices,
  resolveScopes,
  resolveRuleSet,
  buildRuleBody,
  buildRuleSetBody,
  ruleSignature,
  liveRuleSignature,
  labelIdentity,
  ALL_WORKLOADS_ACTOR,
  type Resolvers,
  type RuleSetSpec,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodScope = '[{"key":"env","value":"E-Prod"}]'
const goodRules = JSON.stringify([
  {
    providers: [{ label: { key: 'role', value: 'R-Web' } }],
    consumers: [{ label: { key: 'role', value: 'R-DB' } }],
    services: [{ name: 'HTTPS' }],
  },
])

const good = { name: 'Web-to-DB', scopeLabelsJson: goodScope, rulesJson: goodRules }

// --- validate -----------------------------------------------------------------

test('validate accepts a good ruleset', () => {
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

test('validate requires at least one scope label', () => {
  const res = validate(ctxOf([{ ...good, scopeLabelsJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_scope'))
})

test('validate rejects invalid scope JSON', () => {
  const res = validate(ctxOf([{ ...good, scopeLabelsJson: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].scopeLabelsJson' && e.code === 'invalid_json'))
})

test('validate requires at least one rule', () => {
  const res = validate(ctxOf([{ ...good, rulesJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_rules'))
})

test('validate rejects a rule with no providers', () => {
  const rules = JSON.stringify([{ providers: [], consumers: [{ allWorkloads: true }], services: [{ name: 'HTTPS' }] }])
  const res = validate(ctxOf([{ ...good, rulesJson: rules }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_providers'))
})

test('validate rejects a rule with no services', () => {
  const rules = JSON.stringify([{ providers: [{ allWorkloads: true }], consumers: [{ allWorkloads: true }], services: [] }])
  const res = validate(ctxOf([{ ...good, rulesJson: rules }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'empty_services'))
})

test('validate rejects a provider with zero actor kinds set', () => {
  const rules = JSON.stringify([{ providers: [{}], consumers: [{ allWorkloads: true }], services: [{ name: 'HTTPS' }] }])
  const res = validate(ctxOf([{ ...good, rulesJson: rules }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_actor' && e.field === 'items[0].rulesJson[0].providers[0]'))
})

test('validate rejects a provider with two actor kinds set', () => {
  const rules = JSON.stringify([
    { providers: [{ allWorkloads: true, ipList: 'Public Internet' }], consumers: [{ allWorkloads: true }], services: [{ name: 'HTTPS' }] },
  ])
  const res = validate(ctxOf([{ ...good, rulesJson: rules }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_actor'))
})

test('validate accepts an ipList and allWorkloads actor', () => {
  const rules = JSON.stringify([{ providers: [{ ipList: 'Public Internet' }], consumers: [{ allWorkloads: true }], services: [{ name: 'HTTPS' }] }])
  const res = validate(ctxOf([{ ...good, rulesJson: rules }]))
  assert.equal(res.valid, true)
})

// --- parsing helpers -------------------------------------------------------------

test('parseLabelRefArray parses a JSON array of label refs', () => {
  const { value, error } = parseLabelRefArray('[{"key":"env","value":"Prod"}]')
  assert.equal(error, undefined)
  assert.deepEqual(value, [{ key: 'env', value: 'Prod' }])
})

test('parseLabelRefArray reports invalid JSON', () => {
  const { value, error } = parseLabelRefArray('{not json')
  assert.equal(value.length, 0)
  assert.ok(error?.includes('not valid JSON'))
})

test('parseLabelRefArray reports a non-array root', () => {
  const { error } = parseLabelRefArray('{"key":"env"}')
  assert.ok(error?.includes('JSON array'))
})

test('parseRulesJson parses a JSON array of rules with defaults', () => {
  const { value, error } = parseRulesJson('[{"providers":[{"allWorkloads":true}],"consumers":[{"allWorkloads":true}],"services":[{"name":"HTTPS"}]}]')
  assert.equal(error, undefined)
  assert.equal(value[0].enabled, true)
  assert.equal(value[0].providers[0].allWorkloads, true)
})

test('parseRulesJson reports invalid JSON', () => {
  const { error } = parseRulesJson('[bad')
  assert.ok(error?.includes('not valid JSON'))
})

// --- extractRuleSetSpecs --------------------------------------------------------

test('extractRuleSetSpecs parses scope + rules JSON', () => {
  const specs = extractRuleSetSpecs({ items: [{ id: 'i1', name: 'A', fields: good }] } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].scopeLabels[0].key, 'env')
  assert.equal(specs[0].rules[0].providers[0].label?.value, 'R-Web')
  assert.equal(specs[0].rules[0].services[0].name, 'HTTPS')
  assert.equal(specs[0].enabled, true)
})

// --- resolution (fail closed) ---------------------------------------------------

function resolversOf(labels: Array<[string, string]>, ipLists: string[], services: string[]): Resolvers {
  return {
    labelHrefByIdentity: new Map(labels.map(([k, v]) => [labelIdentity(k, v), `/orgs/1/labels/${k}-${v}`])),
    ipListHrefByName: new Map(ipLists.map((n) => [n.toLowerCase(), `/orgs/1/sec_policy/draft/ip_lists/${n}`])),
    serviceHrefByName: new Map(services.map((n) => [n.toLowerCase(), `/orgs/1/sec_policy/draft/services/${n}`])),
  }
}

test('resolveProviderConsumer resolves a label to its href', () => {
  const resolvers = resolversOf([['role', 'R-Web']], [], [])
  assert.deepEqual(resolveProviderConsumer({ label: { key: 'role', value: 'R-Web' } }, resolvers, 'a provider'), {
    label: { href: '/orgs/1/labels/role-R-Web' },
  })
})

test('resolveProviderConsumer resolves allWorkloads to the ams actor', () => {
  const resolvers = resolversOf([], [], [])
  assert.deepEqual(resolveProviderConsumer({ allWorkloads: true }, resolvers, 'a provider'), { actors: ALL_WORKLOADS_ACTOR })
})

test('resolveProviderConsumer FAILS CLOSED on an unresolved label', () => {
  const resolvers = resolversOf([], [], [])
  assert.throws(() => resolveProviderConsumer({ label: { key: 'role', value: 'R-Ghost' } }, resolvers, 'a provider'), /does not exist/)
})

test('resolveProviderConsumer FAILS CLOSED on an unresolved IP list', () => {
  const resolvers = resolversOf([], [], [])
  assert.throws(() => resolveProviderConsumer({ ipList: 'Ghost List' }, resolvers, 'a consumer'), /does not exist/)
})

test('resolveIngressServices FAILS CLOSED on an unresolved service', () => {
  const resolvers = resolversOf([], [], ['HTTPS'])
  assert.throws(() => resolveIngressServices([{ name: 'Ghost' }], resolvers), /does not exist/)
  assert.deepEqual(resolveIngressServices([{ name: 'HTTPS' }], resolvers), [{ href: '/orgs/1/sec_policy/draft/services/HTTPS' }])
})

test('resolveScopes produces one AND-group', () => {
  const resolvers = resolversOf([['env', 'Prod'], ['app', 'Web']], [], [])
  const scopes = resolveScopes(
    [{ key: 'env', value: 'Prod' }, { key: 'app', value: 'Web' }],
    resolvers,
  )
  assert.equal(scopes.length, 1)
  assert.equal(scopes[0].length, 2)
})

test('resolveRuleSet FAILS CLOSED when any rule reference is unresolved', () => {
  const resolvers = resolversOf([['env', 'Prod']], [], [])
  const spec: RuleSetSpec = {
    name: 'X',
    description: '',
    enabled: true,
    scopeLabels: [{ key: 'env', value: 'Prod' }],
    rules: [{ enabled: true, providers: [{ allWorkloads: true }], consumers: [{ allWorkloads: true }], services: [{ name: 'Ghost' }] }],
    externalDataSet: '',
    externalDataReference: '',
  }
  assert.throws(() => resolveRuleSet(spec, resolvers), /does not exist/)
})

test('resolveRuleSet succeeds and produces a stable signature per rule', () => {
  const resolvers = resolversOf([['env', 'Prod']], [], ['HTTPS'])
  const spec: RuleSetSpec = {
    name: 'X',
    description: '',
    enabled: true,
    scopeLabels: [{ key: 'env', value: 'Prod' }],
    rules: [{ enabled: true, providers: [{ allWorkloads: true }], consumers: [{ allWorkloads: true }], services: [{ name: 'HTTPS' }] }],
    externalDataSet: '',
    externalDataReference: '',
  }
  const resolved = resolveRuleSet(spec, resolvers)
  assert.equal(resolved.rules.length, 1)
  assert.equal(typeof resolved.rules[0].signature, 'string')
})

// --- signature matching (declared vs live) --------------------------------------

test('ruleSignature matches liveRuleSignature for the same logical rule', () => {
  const resolvers = resolversOf([['role', 'R-Web'], ['role', 'R-DB']], [], ['HTTPS'])
  const body = buildRuleBody(
    { enabled: true, providers: [{ label: { key: 'role', value: 'R-Web' } }], consumers: [{ label: { key: 'role', value: 'R-DB' } }], services: [{ name: 'HTTPS' }] },
    resolvers,
  )
  const sig = ruleSignature(body)

  // Simulate what the PCE would echo back — same refs, plus server-added fields
  // (embedded label key/value) and providers/consumers possibly reordered.
  const live = {
    enabled: true,
    description: '',
    providers: [{ label: { href: resolvers.labelHrefByIdentity.get(labelIdentity('role', 'R-Web')), key: 'role', value: 'R-Web' } }],
    consumers: [{ label: { href: resolvers.labelHrefByIdentity.get(labelIdentity('role', 'R-DB')), key: 'role', value: 'R-DB' } }],
    ingress_services: [{ href: resolvers.serviceHrefByName.get('https') }],
    resolve_labels_as: { providers: ['workloads'], consumers: ['workloads'] },
  }
  assert.equal(liveRuleSignature(live), sig)
})

test('ruleSignature differs when the rule shape differs', () => {
  const resolvers = resolversOf([['role', 'R-Web']], [], ['HTTPS'])
  const a = buildRuleBody({ enabled: true, providers: [{ allWorkloads: true }], consumers: [{ label: { key: 'role', value: 'R-Web' } }], services: [{ name: 'HTTPS' }] }, resolvers)
  const b = buildRuleBody({ enabled: false, providers: [{ allWorkloads: true }], consumers: [{ label: { key: 'role', value: 'R-Web' } }], services: [{ name: 'HTTPS' }] }, resolvers)
  assert.notEqual(ruleSignature(a), ruleSignature(b))
})

// --- ruleset body builder --------------------------------------------------------

test('buildRuleSetBody omits blank optional fields', () => {
  const body = buildRuleSetBody(
    { name: 'X', description: '', enabled: true, scopeLabels: [], rules: [], externalDataSet: '', externalDataReference: '' },
    [[{ label: { href: '/orgs/1/labels/1' } }]],
  )
  assert.deepEqual(body, { name: 'X', enabled: true, scopes: [[{ label: { href: '/orgs/1/labels/1' } }]] })
})
