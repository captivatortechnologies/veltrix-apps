import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  validateArtifactDefinition,
  normalizeDefinition,
  findArtifact,
} from '../_shared'
import {
  parseApiClientBundle,
  resolveApiClientConfig,
  isApiClientConfigComplete,
  artifactSetVQL,
  artifactDeleteVQL,
  artifactDefinitionsVQL,
  vqlQuote,
  createVelociraptorClient,
  extractVersion,
  INFO_VQL,
  type VelociraptorTransport,
} from '../../../lib/velociraptorApi'
import type { PipelineContext, ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'

// --- validate (pure, network-free) --------------------------------------------

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodDefinition = ['name: Custom.Windows.Detection.Foo', 'type: CLIENT', 'sources:', '  - query: SELECT * FROM info()'].join('\n')
const good = { name: 'Custom.Windows.Detection.Foo', type: 'CLIENT', description: 'Test', definition: goodDefinition }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'HUNT' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an empty definition', async () => {
  const res = await validate(ctxOf([{ ...good, definition: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DEFINITION'))
})

test('validate rejects a definition with no name: key', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'type: CLIENT\nsources: []' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEFINITION'))
})

test('validate rejects a definition indented with tabs', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Foo\n\ttype: CLIENT' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEFINITION'))
})

test('validate rejects a definition with malformed YAML syntax', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Foo\n  bad indent: [1,2' }]))
  assert.equal(res.valid, false)
  const err = res.errors.find((e) => e.code === 'INVALID_DEFINITION')
  assert.ok(err)
  assert.match(err!.message, /YAML syntax error/)
})

test('validate rejects a definition whose root is a list, not a mapping', async () => {
  const res = await validate(ctxOf([{ ...good, definition: '- name: Custom.Foo\n- type: CLIENT' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEFINITION'))
})

test('validate rejects a definition with a badly-formatted name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad!name', definition: 'name: bad!name\nsources:\n  - query: SELECT 1' }]))
  assert.equal(res.valid, false)
  // Both the item-level name check and the definition-level name check fire.
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEFINITION'))
})

test('validate rejects a definition whose type: is not a recognized artifact type', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Windows.Detection.Foo\ntype: HUNT\nsources:\n  - query: SELECT 1' }]))
  assert.equal(res.valid, false)
  const err = res.errors.find((e) => e.code === 'INVALID_DEFINITION')
  assert.ok(err)
  assert.match(err!.message, /must be one of/)
})

test('validate accepts a definition type: of NOTEBOOK or INTERNAL (not offered on the item, but valid in YAML)', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Windows.Detection.Foo\ntype: NOTEBOOK\nsources:\n  - query: SELECT 1' }]))
  assert.equal(res.errors.some((e) => e.code === 'INVALID_DEFINITION'), false)
})

test('validate rejects a source with neither query nor queries', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Windows.Detection.Foo\ntype: CLIENT\nsources:\n  - name: Main' }]))
  assert.equal(res.valid, false)
  const err = res.errors.find((e) => e.code === 'INVALID_DEFINITION')
  assert.ok(err)
  assert.match(err!.message, /non-empty "query" or a non-empty "queries"/)
})

test('validate rejects an explicitly empty sources: list', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Windows.Detection.Foo\ntype: CLIENT\nsources: []' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEFINITION'))
})

test('validate accepts a source using queries: (list form)', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Windows.Detection.Foo\ntype: CLIENT\nsources:\n  - queries:\n      - SELECT 1\n      - SELECT 2' }]))
  assert.equal(res.errors.some((e) => e.code === 'INVALID_DEFINITION'), false)
})

test('validate warns when a definition has no sources: and no top-level query:', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Windows.Detection.Foo\ntype: CLIENT' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'COLLECTS_NOTHING' && /collects nothing/.test(w.message)))
})

test('validate does not warn about empty sources when a top-level query: is present', async () => {
  const res = await validate(ctxOf([{ ...good, definition: 'name: Custom.Windows.Detection.Foo\ntype: CLIENT\nquery: SELECT 1' }]))
  assert.equal(res.warnings.some((w) => w.code === 'COLLECTS_NOTHING'), false)
})

test('validate rejects a malformed parameters: entry', async () => {
  const definition = 'name: Custom.Windows.Detection.Foo\ntype: CLIENT\nsources:\n  - query: SELECT 1\nparameters:\n  - default: x'
  const res = await validate(ctxOf([{ ...good, definition }]))
  assert.equal(res.valid, false)
  const err = res.errors.find((e) => e.code === 'INVALID_DEFINITION')
  assert.ok(err)
  assert.match(err!.message, /parameters\[0\]/)
})

test('validate accepts well-formed parameters:', async () => {
  const definition = 'name: Custom.Windows.Detection.Foo\ntype: CLIENT\nsources:\n  - query: SELECT 1\nparameters:\n  - name: Foo\n    default: bar'
  const res = await validate(ctxOf([{ ...good, definition }]))
  assert.equal(res.errors.some((e) => e.code === 'INVALID_DEFINITION'), false)
})

test('validate warns on a name/definition mismatch', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Custom.Other.Name' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NAME_MISMATCH'))
})

test('validate warns on a type mismatch', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'SERVER' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'TYPE_MISMATCH'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good artifact for each type', async () => {
  for (const type of ['CLIENT', 'SERVER', 'CLIENT_EVENT', 'SERVER_EVENT']) {
    const definition = goodDefinition.replace('type: CLIENT', `type: ${type}`)
    const res = await validate(ctxOf([{ ...good, type, definition }]))
    assert.equal(res.valid, true, `expected ${type} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('validateArtifactDefinition reads the name/type of a good definition', () => {
  const check = validateArtifactDefinition(goodDefinition)
  assert.equal(check.ok, true)
  assert.equal(check.name, 'Custom.Windows.Detection.Foo')
  assert.equal(check.type, 'CLIENT')
  assert.deepEqual(check.warnings, [])
})

test('validateArtifactDefinition rejects empty, non-mapping, and no-name definitions', () => {
  assert.equal(validateArtifactDefinition('').ok, false)
  assert.equal(validateArtifactDefinition('just a scalar string').ok, false)
  assert.equal(validateArtifactDefinition('- a\n- b').ok, false)
  assert.equal(validateArtifactDefinition('sources: []').ok, false)
})

test('validateArtifactDefinition rejects a YAML syntax error', () => {
  const check = validateArtifactDefinition('name: Custom.Foo\n  bad indent: [1,2')
  assert.equal(check.ok, false)
  assert.match(check.reason ?? '', /YAML syntax error/)
})

test('validateArtifactDefinition rejects tab indentation (invalid YAML)', () => {
  assert.equal(validateArtifactDefinition('name: X\n\tbad: 1').ok, false)
})

test('validateArtifactDefinition warns, but does not fail, when the definition collects nothing', () => {
  const check = validateArtifactDefinition('name: Custom.Foo')
  assert.equal(check.ok, true)
  assert.ok(check.warnings.some((w) => /collects nothing/.test(w)))
})

test('normalizeDefinition ignores trailing whitespace and line endings', () => {
  assert.equal(normalizeDefinition('name: X  \r\ntype: CLIENT\n\n'), normalizeDefinition('name: X\ntype: CLIENT'))
})

test('findArtifact matches by exact name', () => {
  const live = [{ name: 'Custom.A' }, { name: 'Custom.B' }]
  assert.equal(findArtifact(live, 'Custom.B')?.name, 'Custom.B')
  assert.equal(findArtifact(live, 'Custom.C'), null)
})

// --- api-client bundle parsing + resolution -----------------------------------

const bundle = [
  'ca_certificate: |',
  '  -----BEGIN CERTIFICATE-----',
  '  CA_LINE_ONE',
  '  CA_LINE_TWO',
  '  -----END CERTIFICATE-----',
  'client_cert: |',
  '  -----BEGIN CERTIFICATE-----',
  '  CLIENT_CERT_LINE',
  '  -----END CERTIFICATE-----',
  'client_private_key: |',
  '  KEYMATERIAL_LINE_ONE',
  '  KEYMATERIAL_LINE_TWO',
  'api_connection_string: localhost:8001',
  'name: veltrix',
  '',
].join('\n')

test('parseApiClientBundle extracts the four pieces', () => {
  const parsed = parseApiClientBundle(bundle)
  assert.ok(parsed.caCertificate?.includes('CA_LINE_ONE'))
  assert.ok(parsed.caCertificate?.includes('CA_LINE_TWO'))
  assert.ok(parsed.clientCert?.includes('CLIENT_CERT_LINE'))
  assert.ok(!parsed.clientCert?.includes('CA_LINE_ONE'))
  assert.ok(parsed.clientPrivateKey?.includes('KEYMATERIAL_LINE_ONE'))
  assert.equal(parsed.apiConnectionString, 'localhost:8001')
})

test('resolveApiClientConfig reads a bundle from the certificate field', () => {
  const credential = { certificate: bundle, apiToken: null } as unknown as CredentialRef
  const config = resolveApiClientConfig(credential, null, null)
  assert.ok(config.caCertificate.includes('CA_LINE_ONE'))
  assert.ok(config.clientCert.includes('CLIENT_CERT_LINE'))
  assert.ok(config.clientPrivateKey.includes('KEYMATERIAL_LINE_ONE'))
  assert.equal(config.apiConnectionString, 'localhost:8001')
  assert.equal(isApiClientConfigComplete(config), true)
})

test('resolveApiClientConfig reads a bundle from the apiToken field', () => {
  const credential = { certificate: null, apiToken: bundle } as unknown as CredentialRef
  const config = resolveApiClientConfig(credential, null, null)
  assert.ok(config.clientPrivateKey.includes('KEYMATERIAL_LINE_ONE'))
  assert.equal(config.apiConnectionString, 'localhost:8001')
})

test('resolveApiClientConfig falls back to the connection endpoint for the address', () => {
  const bundleNoAddr = bundle.replace('api_connection_string: localhost:8001\n', '')
  const credential = { certificate: bundleNoAddr } as unknown as CredentialRef
  const component = { hostname: 'velo.example.com', port: '8001' } as unknown as ComponentRef
  const config = resolveApiClientConfig(credential, component, null)
  assert.equal(config.apiConnectionString, 'velo.example.com:8001')
})

test('isApiClientConfigComplete is false when material is missing', () => {
  assert.equal(
    isApiClientConfigComplete({ caCertificate: 'x', clientCert: '', clientPrivateKey: 'y', apiConnectionString: 'h:1' }),
    false,
  )
})

// --- VQL builders -------------------------------------------------------------

test('vqlQuote escapes single quotes', () => {
  assert.equal(vqlQuote("it's"), "'it''s'")
})

test('artifactSetVQL embeds the definition YAML', () => {
  const vql = artifactSetVQL('name: Custom.Foo')
  assert.match(vql, /artifact_set\(definition='name: Custom\.Foo'\)/)
  assert.match(vql, /FROM scope\(\)/)
})

test('artifactDeleteVQL names the artifact', () => {
  assert.match(artifactDeleteVQL('Custom.Foo'), /artifact_delete\(name='Custom\.Foo'\)/)
})

test('artifactDefinitionsVQL narrows to names when given', () => {
  assert.equal(artifactDefinitionsVQL(), 'SELECT * FROM artifact_definitions()')
  assert.match(artifactDefinitionsVQL(['Custom.A', 'Custom.B']), /artifact_definitions\(names=\['Custom\.A', 'Custom\.B'\]\)/)
})

// --- client over an injected (fake) transport ---------------------------------

function fakeTransport(rowsByQuery: Record<string, Array<Record<string, unknown>>>): VelociraptorTransport {
  return {
    runVQL: async (query) => rowsByQuery[query] ?? [],
    close: async () => {},
  }
}

test('createVelociraptorClient runs VQL over the injected transport', async () => {
  const transport = fakeTransport({ [INFO_VQL]: [{ version: '0.72.1' }], 'SELECT 1': [{ n: 1 }] })
  const client = await createVelociraptorClient(
    { caCertificate: '', clientCert: '', clientPrivateKey: '', apiConnectionString: '' },
    { transport },
  )
  assert.deepEqual(await client.runVQL('SELECT 1'), [{ n: 1 }])
  assert.equal(await client.getVersion(), '0.72.1')
  await client.close()
})

test('extractVersion reads version-ish fields defensively', () => {
  assert.equal(extractVersion([{ version: '1.2.3' }]), '1.2.3')
  assert.equal(extractVersion([{ Version: { version: '4.5.6' } }]), '4.5.6')
  assert.equal(extractVersion([{ foo: 'bar' }]), 'connected')
  assert.equal(extractVersion([]), null)
})
