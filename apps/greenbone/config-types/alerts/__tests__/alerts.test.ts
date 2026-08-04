import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateAlertCommand, buildModifyAlertCommand, buildDeleteAlertCommand, parseAlerts } from '../../../lib/gmp/alerts'
import { buildAlertInput, findAlertByName } from '../_shared'

// The deploy/rollback/health/drift handlers talk to gvmd over a live TLS
// socket, which cannot be mocked here (house convention). These tests exercise
// validate.ts, _shared.ts and the GMP command assembly + response parsing.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Scan Complete', event: 'Task run status changed', eventStatus: 'Done', condition: 'Always', method: 'Email', emailTo: 'sec@example.com' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unrecognised event', async () => {
  const res = await validate(ctxOf([{ ...good, event: 'Nonsense' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EVENT'))
})

test('validate rejects a secret-backed method', async () => {
  const res = await validate(ctxOf([{ ...good, method: 'SCP' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_METHOD'))
})

test('validate requires emailTo for the Email method', async () => {
  const res = await validate(ctxOf([{ ...good, emailTo: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EMAIL_TO'))
})

test('validate requires httpUrl for the HTTP Get method', async () => {
  const res = await validate(ctxOf([{ ...good, method: 'HTTP Get', httpUrl: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_HTTP_URL'))
})

test('validate requires a minimum severity for "Severity at least"', async () => {
  const res = await validate(ctxOf([{ ...good, condition: 'Severity at least', conditionSeverity: undefined }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONDITION_SEVERITY'))
})

test('validate warns on a duplicate alert name', async () => {
  const res = await validate(ctxOf([good, { ...good, emailTo: 'other@example.com' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good alert', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- command builders --------------------------------------------------------

test('buildCreateAlertCommand nests data as {value}<name>{key}</name>', () => {
  const xml = buildCreateAlertCommand({
    name: 'emergency',
    condition: { value: 'Severity at least', data: [{ name: 'severity', value: '5.5' }] },
    event: { value: 'Task run status changed', data: [{ name: 'status', value: 'Done' }] },
    method: { value: 'Email', data: [{ name: 'to_address', value: 'sally@example.org' }] },
  })
  assert.ok(xml.includes('<condition>Severity at least<data>5.5<name>severity</name></data></condition>'))
  assert.ok(xml.includes('<event>Task run status changed<data>Done<name>status</name></data></event>'))
  assert.ok(xml.includes('<method>Email<data>sally@example.org<name>to_address</name></data></method>'))
})

test('buildModifyAlertCommand always resends condition/event/method', () => {
  const xml = buildModifyAlertCommand('a1', {
    name: 'Renamed',
    condition: { value: 'Always' },
    event: { value: 'Task run status changed' },
    method: { value: 'Syslog' },
  })
  assert.ok(xml.startsWith('<modify_alert alert_id="a1">'))
  assert.ok(xml.includes('<condition>Always</condition>'))
  assert.ok(xml.includes('<method>Syslog</method>'))
})

test('buildDeleteAlertCommand sets ultimate', () => {
  assert.equal(buildDeleteAlertCommand('a1', true), '<delete_alert alert_id="a1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseAlerts extracts event/condition/method value and data', () => {
  const xml = `<get_alerts_response status="200">
    <alert id="a1">
      <name>emergency</name>
      <condition>Severity at least<data>5.5<name>severity</name></data></condition>
      <event>Task run status changed<data>Done<name>status</name></data></event>
      <method>Email<data>sally@example.org<name>to_address</name></data></method>
    </alert>
  </get_alerts_response>`
  const [a] = parseAlerts(xml)
  assert.equal(a.id, 'a1')
  assert.equal(a.condition.value, 'Severity at least')
  assert.deepEqual(a.condition.data, [{ name: 'severity', value: '5.5' }])
  assert.equal(a.method.value, 'Email')
  assert.deepEqual(a.method.data, [{ name: 'to_address', value: 'sally@example.org' }])
})

// --- _shared helpers -----------------------------------------------------------

test('buildAlertInput maps method-specific fields into clause data', () => {
  const input = buildAlertInput(good)
  assert.equal(input.method.value, 'Email')
  assert.deepEqual(input.method.data, [{ name: 'to_address', value: 'sec@example.com' }])
  assert.equal(input.event.data?.[0]?.name, 'status')
})

test('findAlertByName matches on the trimmed name', () => {
  const alerts = parseAlerts('<get_alerts_response><alert id="a1"><name>emergency</name></alert></get_alerts_response>')
  assert.equal(findAlertByName(alerts, 'emergency')?.id, 'a1')
  assert.equal(findAlertByName(alerts, 'Nope'), null)
})
