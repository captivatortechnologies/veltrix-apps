import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractExtensionSpecs,
  parseExtensionObjects,
  parseExtensionConfig,
  looksLikeUrl,
  buildExtensionBody,
  extensionRestoreBody,
  findExtension,
  findExtensionSchemaId,
  findServiceId,
  extensionSchemaLabel,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (parsing / extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const OBJECTS = '["My Web App", "Checkout API"]'
const good = {
  name: 'My Web App Extension',
  extension_schema: 'Generic V2 Webhook',
  endpoint_url: 'https://example.com/receive_a_pagerduty_webhook',
  extension_objects: OBJECTS,
  config: '{"restrict":"any"}',
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid extension', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing extension schema', async () => {
  const res = await validate(ctxOf([{ ...good, extension_schema: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EXTENSION_SCHEMA'))
})

test('validate accepts a blank endpoint_url', async () => {
  const res = await validate(ctxOf([{ ...good, endpoint_url: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed endpoint_url', async () => {
  const res = await validate(ctxOf([{ ...good, endpoint_url: 'not a url' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENDPOINT_URL'))
})

test('validate rejects missing extension_objects', async () => {
  const res = await validate(ctxOf([{ ...good, extension_objects: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXTENSION_OBJECTS'))
})

test('validate rejects extension_objects that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, extension_objects: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXTENSION_OBJECTS'))
})

test('validate rejects extension_objects with an empty-string entry', async () => {
  const res = await validate(ctxOf([{ ...good, extension_objects: '["", "Checkout API"]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXTENSION_OBJECTS'))
})

test('validate rejects extension_objects that parse to an empty array', async () => {
  const res = await validate(ctxOf([{ ...good, extension_objects: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXTENSION_OBJECTS'))
})

test('validate accepts a blank config', async () => {
  const res = await validate(ctxOf([{ ...good, config: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a config that is not a JSON object', async () => {
  const res = await validate(ctxOf([{ ...good, config: '[1,2,3]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, endpoint_url: 'https://example.com/other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('parseExtensionObjects returns typed names for a valid array', () => {
  const parsed = parseExtensionObjects(OBJECTS)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.names, ['My Web App', 'Checkout API'])
})

test('parseExtensionObjects flags a non-array', () => {
  const parsed = parseExtensionObjects('{"a":1}')
  assert.equal(parsed.names, null)
  assert.ok(parsed.error)
})

test('parseExtensionConfig accepts a blank value', () => {
  const parsed = parseExtensionConfig('')
  assert.equal(parsed.config, null)
  assert.equal(parsed.error, null)
})

test('parseExtensionConfig rejects an array', () => {
  const parsed = parseExtensionConfig('[1,2]')
  assert.equal(parsed.config, null)
  assert.ok(parsed.error)
})

test('looksLikeUrl accepts http(s) and rejects garbage', () => {
  assert.equal(looksLikeUrl('https://example.com/hook'), true)
  assert.equal(looksLikeUrl('ftp://example.com'), false)
  assert.equal(looksLikeUrl('not a url'), false)
})

test('extractExtensionSpecs trims fields and carries raw JSON text', () => {
  const specs = extractExtensionSpecs(ctxOf([{ name: '  My Web App Extension  ', extension_schema: '  Generic V2 Webhook  ', extension_objects: OBJECTS }]).canvas)
  assert.equal(specs[0].name, 'My Web App Extension')
  assert.equal(specs[0].extensionSchemaName, 'Generic V2 Webhook')
  assert.equal(specs[0].extensionObjectsJson, OBJECTS)
})

test('buildExtensionBody sets type + resolved references and omits blanks', () => {
  const body = buildExtensionBody(
    { itemName: 'g', name: 'My Web App Extension', extensionSchemaName: 'Generic V2 Webhook', endpointUrl: '', extensionObjectsJson: OBJECTS, configJson: '' },
    'PJFWPEP',
    ['PIJ90N7', 'PABC123'],
    null,
  )
  assert.equal(body.type, 'extension')
  assert.equal(body.name, 'My Web App Extension')
  assert.equal(body.extension_schema?.id, 'PJFWPEP')
  assert.equal(body.extension_schema?.type, 'extension_schema_reference')
  assert.deepEqual(body.extension_objects, [
    { id: 'PIJ90N7', type: 'service_reference' },
    { id: 'PABC123', type: 'service_reference' },
  ])
  assert.equal(body.endpoint_url, undefined)
  assert.equal(body.config, undefined)
})

test('extensionRestoreBody reconstructs the prior body including its resolved references', () => {
  const body = extensionRestoreBody({
    id: 'PPGPXHO',
    name: 'My Web App Extension',
    endpoint_url: 'https://example.com/hook',
    extension_schema: { id: 'PJFWPEP', type: 'extension_schema_reference', summary: 'Generic Webhook' },
    extension_objects: [{ id: 'PIJ90N7', type: 'service_reference', summary: 'My Application Service' }],
    config: { anykey: 'anyvalue' },
  })
  assert.equal(body.type, 'extension')
  assert.equal(body.extension_schema?.id, 'PJFWPEP')
  assert.deepEqual(body.extension_objects, [{ id: 'PIJ90N7', type: 'service_reference' }])
  assert.equal(body.endpoint_url, 'https://example.com/hook')
  assert.deepEqual(body.config, { anykey: 'anyvalue' })
})

test('findExtension matches by name case-insensitively', () => {
  const live = [{ id: 'PPGPXHO', name: 'My Web App Extension' }, { id: 'P2', name: 'Other' }]
  assert.equal(findExtension(live, 'my web app extension')?.id, 'PPGPXHO')
  assert.equal(findExtension(live, 'missing'), null)
})

test('findExtensionSchemaId matches summary then falls back to label', () => {
  const schemas = [
    { id: 'PJFWPEP', summary: 'Generic Webhook' },
    { id: 'PSLACK1', label: 'Slack' },
  ]
  assert.equal(findExtensionSchemaId(schemas, 'generic webhook'), 'PJFWPEP')
  assert.equal(findExtensionSchemaId(schemas, 'slack'), 'PSLACK1')
  assert.equal(findExtensionSchemaId(schemas, 'nope'), null)
})

test('findServiceId resolves a service name to its id', () => {
  const services = [{ id: 'PIJ90N7', name: 'My Web App' }, { id: 'PABC123', name: 'Checkout API' }]
  assert.equal(findServiceId(services, 'checkout api'), 'PABC123')
  assert.equal(findServiceId(services, 'nope'), null)
})

test('extensionSchemaLabel prefers summary, then label, then id', () => {
  assert.equal(extensionSchemaLabel({ id: 'P1', summary: 'Generic Webhook', label: 'Generic' }), 'Generic Webhook')
  assert.equal(extensionSchemaLabel({ id: 'P1', label: 'Generic' }), 'Generic')
  assert.equal(extensionSchemaLabel({ id: 'P1' }), 'P1')
})
