import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateScannerCommand, buildModifyScannerCommand, buildDeleteScannerCommand, parseScannersFull, SCANNER_TYPE_OPENVAS } from '../../../lib/gmp/scanners'
import { buildScannerInput, findScannerByName } from '../_shared'

// The deploy/rollback/health/drift handlers talk to gvmd over a live TLS
// socket, which cannot be mocked here (house convention). These tests exercise
// validate.ts, _shared.ts and the GMP command assembly + response parsing.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Remote Sensor', host: 'sensor.example.com', port: 9391, type: '2', credentialId: '254cd3ef-1234-4a5b-8c9d-0123456789ab' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing host', async () => {
  const res = await validate(ctxOf([{ ...good, host: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_HOST'))
})

test('validate rejects an out-of-range port', async () => {
  const res = await validate(ctxOf([{ ...good, port: 99999 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '99' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate warns on an unverified (non-OpenVAS) type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '3' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNVERIFIED_TYPE'))
})

test('validate rejects a non-UUID credential', async () => {
  const res = await validate(ctxOf([{ ...good, credentialId: 'not-a-uuid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CREDENTIAL'))
})

test('validate accepts a good scanner', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- command builders --------------------------------------------------------

test('buildCreateScannerCommand emits every required field including an empty ca_pub element', () => {
  const xml = buildCreateScannerCommand({ name: 'S1', host: 'h', port: 9391, type: SCANNER_TYPE_OPENVAS, credentialId: 'c1' })
  assert.ok(xml.includes('<name>S1</name>'))
  assert.ok(xml.includes('<host>h</host>'))
  assert.ok(xml.includes('<port>9391</port>'))
  assert.ok(xml.includes('<type>2</type>'))
  assert.ok(xml.includes('<ca_pub></ca_pub>'))
  assert.ok(xml.includes('<credential id="c1"/>'))
})

test('buildModifyScannerCommand always resends host/port/type/ca_pub/credential', () => {
  const xml = buildModifyScannerCommand('s1', { name: 'Renamed', host: 'h2', port: 9391, type: '2', credentialId: 'c2', caPub: 'PEM' })
  assert.ok(xml.startsWith('<modify_scanner scanner_id="s1">'))
  assert.ok(xml.includes('<host>h2</host>'))
  assert.ok(xml.includes('<ca_pub>PEM</ca_pub>'))
  assert.ok(xml.includes('<credential id="c2"/>'))
})

test('buildDeleteScannerCommand sets ultimate', () => {
  assert.equal(buildDeleteScannerCommand('s1', true), '<delete_scanner scanner_id="s1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseScannersFull extracts the full field set', () => {
  const xml = `<get_scanners_response status="200">
    <scanner id="s1">
      <name>Remote Sensor</name>
      <comment>prod</comment>
      <host>sensor.example.com</host>
      <port>9391</port>
      <type>2</type>
      <ca_pub>PEM DATA</ca_pub>
      <credential id="254cd3ef-1234-4a5b-8c9d-0123456789ab"><name>Sensor Cred</name></credential>
    </scanner>
  </get_scanners_response>`
  const [s] = parseScannersFull(xml)
  assert.equal(s.id, 's1')
  assert.equal(s.host, 'sensor.example.com')
  assert.equal(s.port, '9391')
  assert.equal(s.type, '2')
  assert.equal(s.caPub, 'PEM DATA')
  assert.equal(s.credentialId, '254cd3ef-1234-4a5b-8c9d-0123456789ab')
})

// --- _shared helpers -----------------------------------------------------------

test('buildScannerInput defaults port and type', () => {
  const input = buildScannerInput({ name: 'S', host: 'h', credentialId: 'c1' })
  assert.equal(input.port, 9391)
  assert.equal(input.type, SCANNER_TYPE_OPENVAS)
})

test('findScannerByName matches on the trimmed name', () => {
  const scanners = parseScannersFull('<get_scanners_response><scanner id="s1"><name>Remote Sensor</name></scanner></get_scanners_response>')
  assert.equal(findScannerByName(scanners, 'Remote Sensor')?.id, 's1')
  assert.equal(findScannerByName(scanners, 'Nope'), null)
})
