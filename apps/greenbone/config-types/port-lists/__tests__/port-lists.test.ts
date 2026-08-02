import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  buildGetPortListsCommand,
  buildCreatePortListCommand,
  buildModifyPortListCommand,
  buildDeletePortListCommand,
  parsePortLists,
} from '../../../lib/greenboneApi'
import { buildPortListInput, findPortListByName, parsePortRange, canonicalPortRange } from '../_shared'

// Live-socket handlers are unmockable (house convention); these tests cover the
// pure seams: validate.ts, the GMP XML command assembly + response parsing, and
// the port-range grammar in _shared.ts.

// --- validate ---------------------------------------------------------------

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Web + DB', portRange: 'T:1-1024,U:53,T:3389', comment: 'edge' }

test('validate accepts a good port list', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an empty port range', async () => {
  const res = await validate(ctxOf([{ ...good, portRange: '   ' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PORT_RANGE'))
})

test('validate rejects malformed / out-of-range tokens', async () => {
  assert.ok((await validate(ctxOf([{ ...good, portRange: 'X:1-2' }]))).errors.some((e) => e.code === 'INVALID_PORT_RANGE'))
  assert.ok((await validate(ctxOf([{ ...good, portRange: 'T:0-70000' }]))).errors.some((e) => e.code === 'INVALID_PORT_RANGE'))
  assert.ok((await validate(ctxOf([{ ...good, portRange: 'T:500-100' }]))).errors.some((e) => e.code === 'INVALID_PORT_RANGE'))
})

test('validate warns on a duplicate port-list name', async () => {
  const res = await validate(ctxOf([good, { ...good, portRange: 'T:80' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  assert.ok((await validate(ctxOf([]))).errors.some((e) => e.code === 'EMPTY'))
})

// --- command builders -------------------------------------------------------

test('buildGetPortListsCommand asks for details and all rows', () => {
  assert.equal(buildGetPortListsCommand(), '<get_port_lists details="1" filter="rows=-1"/>')
})

test('buildCreatePortListCommand emits name, port_range and comment', () => {
  const xml = buildCreatePortListCommand({ name: 'Web', portRange: 'T:1-1024,U:53', comment: 'edge' })
  assert.ok(xml.startsWith('<create_port_list>'))
  assert.ok(xml.includes('<name>Web</name>'))
  assert.ok(xml.includes('<port_range>T:1-1024,U:53</port_range>'))
  assert.ok(xml.includes('<comment>edge</comment>'))
})

test('buildModifyPortListCommand only sends name/comment (ranges are immutable)', () => {
  const xml = buildModifyPortListCommand('pl-1', { name: 'Web', comment: 'x' })
  assert.equal(xml, '<modify_port_list port_list_id="pl-1"><name>Web</name><comment>x</comment></modify_port_list>')
  assert.ok(!xml.includes('port_range'))
})

test('buildDeletePortListCommand sets ultimate', () => {
  assert.equal(buildDeletePortListCommand('pl-1', true), '<delete_port_list port_list_id="pl-1" ultimate="1"/>')
})

// --- response parsing -------------------------------------------------------

test('parsePortLists reconstructs the compact range from structured port_range triples', () => {
  const xml = `<get_port_lists_response status="200">
    <port_list id="pl-1">
      <name>Web + DB</name>
      <comment>edge</comment>
      <port_ranges>
        <port_range id="r1"><start>1</start><end>1024</end><type>TCP</type></port_range>
        <port_range id="r2"><start>53</start><end>53</end><type>UDP</type></port_range>
        <port_range id="r3"><start>3389</start><end>3389</end><type>TCP</type></port_range>
      </port_ranges>
    </port_list>
  </get_port_lists_response>`
  const [pl] = parsePortLists(xml)
  assert.equal(pl.id, 'pl-1')
  assert.equal(pl.name, 'Web + DB')
  // Sorted canonical form — a single port drops its "-end".
  assert.equal(pl.portRange, 'T:1-1024,T:3389,U:53')
})

// --- _shared port-range grammar ---------------------------------------------

test('parsePortRange separates valid tokens from invalid ones', () => {
  const { tokens, invalid } = parsePortRange('T:1-1024, U:53 , bogus, T:99999')
  assert.equal(tokens.length, 2)
  assert.deepEqual(invalid, ['bogus', 'T:99999'])
})

test('canonicalPortRange is order- and spacing-insensitive and matches the parsed live form', () => {
  const a = canonicalPortRange('U:53, T:3389 , T:1-1024')
  const b = canonicalPortRange('T:1-1024,T:3389,U:53')
  assert.equal(a, b)
  assert.equal(a, 'T:1-1024,T:3389,U:53')
})

test('buildPortListInput canonicalises the range so create matches the live reconstruction', () => {
  const input = buildPortListInput({ name: '  Web  ', portRange: 'u:53, t:1-1024' })
  assert.equal(input.name, 'Web')
  assert.equal(input.portRange, 'T:1-1024,U:53')
})

test('findPortListByName matches on the trimmed name', () => {
  const lists = parsePortLists('<r><port_list id="pl-1"><name>Web + DB</name></port_list></r>')
  assert.equal(findPortListByName(lists, 'Web + DB')?.id, 'pl-1')
  assert.equal(findPortListByName(lists, 'Nope'), null)
})
