import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateOverrideCommand, buildModifyOverrideCommand, buildDeleteOverrideCommand, parseOverrides } from '../../../lib/gmp/overrides'
import { extractSpecs } from '../_shared'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { text: 'Known false positive on this host', nvtOid: '1.3.6.1.4.1.25623.1.0.12345', newSeverity: 0 }

test('validate rejects missing text', async () => {
  const res = await validate(ctxOf([{ ...good, text: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEXT'))
})

test('validate rejects a malformed NVT OID', async () => {
  const res = await validate(ctxOf([{ ...good, nvtOid: 'not-an-oid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NVT_OID'))
})

test('validate rejects an out-of-range new severity', async () => {
  const res = await validate(ctxOf([{ ...good, newSeverity: 15 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NEW_SEVERITY'))
})

test('validate accepts newSeverity of -1 (False Positive)', async () => {
  const res = await validate(ctxOf([{ ...good, newSeverity: -1 }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed port', async () => {
  const res = await validate(ctxOf([{ ...good, port: '80' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT'))
})

test('validate accepts a well-formed port', async () => {
  const res = await validate(ctxOf([{ ...good, port: '80/tcp' }]))
  assert.equal(res.valid, true)
})

// --- command builders --------------------------------------------------------

test('buildCreateOverrideCommand emits text, nvt, new_severity and optional scope', () => {
  const xml = buildCreateOverrideCommand({ text: 'FP', nvtOid: '1.2.3', newSeverity: 0, hosts: '10.0.0.1', port: '80/tcp', daysActive: -1, taskId: 't1' })
  assert.ok(xml.includes('<text>FP</text>'))
  assert.ok(xml.includes('<nvt oid="1.2.3"/>'))
  assert.ok(xml.includes('<new_severity>0</new_severity>'))
  assert.ok(xml.includes('<hosts>10.0.0.1</hosts>'))
  assert.ok(xml.includes('<port>80/tcp</port>'))
  assert.ok(xml.includes('<active>-1</active>'))
  assert.ok(xml.includes('<task id="t1"/>'))
})

test('buildModifyOverrideCommand targets by override_id', () => {
  const xml = buildModifyOverrideCommand('o1', { text: 'Updated', nvtOid: '1.2.3', newSeverity: 5 })
  assert.ok(xml.startsWith('<modify_override override_id="o1">'))
  assert.ok(xml.includes('<new_severity>5</new_severity>'))
})

test('buildDeleteOverrideCommand sets ultimate', () => {
  assert.equal(buildDeleteOverrideCommand('o1', true), '<delete_override override_id="o1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseOverrides extracts nvt oid, severities and task/result refs', () => {
  const xml = `<get_overrides_response><override id="o1">
    <text>FP</text>
    <nvt oid="1.2.3"/>
    <severity>5.0</severity>
    <new_severity>0.0</new_severity>
    <task id="t1"><name>Weekly</name></task>
  </override></get_overrides_response>`
  const [o] = parseOverrides(xml)
  assert.equal(o.nvtOid, '1.2.3')
  assert.equal(o.severity, '5.0')
  assert.equal(o.newSeverity, '0.0')
  assert.equal(o.taskId, 't1')
})

// --- _shared helpers -----------------------------------------------------------

test('extractSpecs parses numeric fields and uses the canvas item id', () => {
  const items = [{ id: 'ov-1', name: 'unused', fields: { ...good, severity: '7.5' } }]
  const [spec] = extractSpecs(items)
  assert.equal(spec.itemId, 'ov-1')
  assert.equal(spec.newSeverity, 0)
  assert.equal(spec.severity, 7.5)
})
