import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  escapeXmlText,
  escapeXmlAttr,
  unescapeXml,
  buildAuthenticateCommand,
  buildGetTargetsCommand,
  buildCreateTargetCommand,
  buildModifyTargetCommand,
  buildDeleteTargetCommand,
  parseGmpStatus,
  parseCreatedId,
  parseTargets,
  parseRootAttributes,
  isCompleteGmpResponse,
  PORT_LIST_ALL_IANA_TCP,
} from '../../../lib/greenboneApi'
import { buildTargetInput, findTargetByName, normalizeHosts } from '../_shared'

// The deploy/rollback/health/drift handlers talk to gvmd over a live TLS socket,
// which cannot be mocked here (house convention). These tests exercise the two
// pure, network-free seams the socket path is built on: validate.ts and the GMP
// XML command assembly + response parsing in lib/greenboneApi.ts.

// --- validate ---------------------------------------------------------------

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Prod Web', hosts: '10.0.0.0/24, 192.168.1.10', portListId: PORT_LIST_ALL_IANA_TCP, comment: 'quarterly' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects empty hosts', async () => {
  const res = await validate(ctxOf([{ ...good, hosts: '   ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_HOSTS'))
})

test('validate rejects a non-UUID port list', async () => {
  const res = await validate(ctxOf([{ ...good, portListId: 'all-tcp' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT_LIST'))
})

test('validate warns on a duplicate target name', async () => {
  const res = await validate(ctxOf([good, { ...good, hosts: '10.1.0.0/24' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good target', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- XML escaping -----------------------------------------------------------

test('escapeXmlText / escapeXmlAttr / unescapeXml round-trip special chars', () => {
  assert.equal(escapeXmlText('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
  assert.equal(escapeXmlAttr(`x"y'z`), 'x&quot;y&apos;z')
  assert.equal(unescapeXml('a &amp; b &lt; c &gt; d'), 'a & b < c > d')
  assert.equal(unescapeXml(escapeXmlAttr(`p&q"r'<s>`)), `p&q"r'<s>`)
})

// --- command builders -------------------------------------------------------

test('buildAuthenticateCommand nests and escapes credentials', () => {
  const xml = buildAuthenticateCommand('admin', 'p<a&ss')
  assert.equal(
    xml,
    '<authenticate><credentials><username>admin</username><password>p&lt;a&amp;ss</password></credentials></authenticate>',
  )
})

test('buildGetTargetsCommand defaults to rows=-1 (all rows)', () => {
  assert.equal(buildGetTargetsCommand(), '<get_targets filter="rows=-1"/>')
  assert.equal(buildGetTargetsCommand({ filter: 'name=Prod' }), '<get_targets filter="name=Prod"/>')
})

test('buildCreateTargetCommand emits name, hosts, port_list id and comment', () => {
  const xml = buildCreateTargetCommand({ name: 'Prod Web', hosts: '10.0.0.0/24', portListId: PORT_LIST_ALL_IANA_TCP, comment: 'q1', excludeHosts: '10.0.0.1' })
  assert.ok(xml.startsWith('<create_target>'))
  assert.ok(xml.includes('<name>Prod Web</name>'))
  assert.ok(xml.includes('<hosts>10.0.0.0/24</hosts>'))
  assert.ok(xml.includes('<exclude_hosts>10.0.0.1</exclude_hosts>'))
  assert.ok(xml.includes(`<port_list id="${PORT_LIST_ALL_IANA_TCP}"/>`))
  assert.ok(xml.includes('<comment>q1</comment>'))
})

test('buildCreateTargetCommand omits optional empty fields', () => {
  const xml = buildCreateTargetCommand({ name: 'X', hosts: '1.2.3.4', portListId: PORT_LIST_ALL_IANA_TCP })
  assert.ok(!xml.includes('<comment>'))
  assert.ok(!xml.includes('<exclude_hosts>'))
})

test('buildModifyTargetCommand targets by target_id and only sends provided fields', () => {
  const xml = buildModifyTargetCommand('abc-123', { hosts: '10.0.0.0/8' })
  assert.equal(xml, '<modify_target target_id="abc-123"><hosts>10.0.0.0/8</hosts></modify_target>')
})

test('buildDeleteTargetCommand sets ultimate', () => {
  assert.equal(buildDeleteTargetCommand('t1', true), '<delete_target target_id="t1" ultimate="1"/>')
  assert.equal(buildDeleteTargetCommand('t1', false), '<delete_target target_id="t1" ultimate="0"/>')
})

// --- response parsing -------------------------------------------------------

test('parseGmpStatus reads status/status_text and ok flag', () => {
  const created = parseGmpStatus('<create_target_response status="201" status_text="OK, resource created" id="e5adc10c-71d0-49fe-aacf-a442ee31d387"/>')
  assert.equal(created.status, '201')
  assert.equal(created.statusText, 'OK, resource created')
  assert.equal(created.ok, true)

  const authFail = parseGmpStatus('<authenticate_response status="400" status_text="Authentication failed"/>')
  assert.equal(authFail.ok, false)
  assert.equal(authFail.status, '400')
})

test('parseCreatedId returns the new resource id', () => {
  assert.equal(
    parseCreatedId('<create_target_response status="201" status_text="OK, resource created" id="e5adc10c-71d0-49fe-aacf-a442ee31d387"/>'),
    'e5adc10c-71d0-49fe-aacf-a442ee31d387',
  )
  assert.equal(parseCreatedId('<modify_target_response status="200" status_text="OK"/>'), null)
})

test('parseRootAttributes reads authenticate_response attributes', () => {
  const a = parseRootAttributes('<authenticate_response status="200" status_text="OK"><role>Admin</role><timezone>UTC</timezone></authenticate_response>')
  assert.equal(a.status, '200')
  assert.equal(a.status_text, 'OK')
})

test('parseTargets extracts id, name, hosts and port_list id per target', () => {
  const xml = `<get_targets_response status="200" status_text="OK">
    <target id="b493b7a8-0001-0000-0000-000000000001">
      <name>Prod Web</name>
      <comment>quarterly</comment>
      <hosts>10.0.0.0/24</hosts>
      <exclude_hosts>10.0.0.1</exclude_hosts>
      <port_list id="33d0cd82-57c6-11e1-8ed1-406186ea4fc5"><name>All IANA assigned TCP</name></port_list>
    </target>
    <target id="c1000000-0002-0000-0000-000000000002">
      <name>DB Tier</name>
      <hosts>db1.example.com, db2.example.com</hosts>
      <port_list id="4a4717fe-57d2-11e1-9a26-406186ea4fc5"><name>All IANA assigned TCP and UDP</name></port_list>
    </target>
  </get_targets_response>`
  const targets = parseTargets(xml)
  assert.equal(targets.length, 2)
  assert.equal(targets[0].id, 'b493b7a8-0001-0000-0000-000000000001')
  assert.equal(targets[0].name, 'Prod Web')
  assert.equal(targets[0].hosts, '10.0.0.0/24')
  assert.equal(targets[0].excludeHosts, '10.0.0.1')
  assert.equal(targets[0].portListId, '33d0cd82-57c6-11e1-8ed1-406186ea4fc5')
  assert.equal(targets[1].name, 'DB Tier')
  assert.equal(targets[1].portListId, '4a4717fe-57d2-11e1-9a26-406186ea4fc5')
})

test('parseTargets unescapes entities in target fields', () => {
  const xml = '<get_targets_response status="200"><target id="t9"><name>A &amp; B</name><hosts>1.1.1.1</hosts></target></get_targets_response>'
  const [t] = parseTargets(xml)
  assert.equal(t.name, 'A & B')
})

// --- framing ----------------------------------------------------------------

test('isCompleteGmpResponse detects self-closing, full and partial responses', () => {
  assert.equal(isCompleteGmpResponse('<create_target_response status="201" id="x"/>'), true)
  assert.equal(isCompleteGmpResponse('<authenticate_response status="200"><role>Admin</role></authenticate_response>'), true)
  assert.equal(isCompleteGmpResponse('<get_targets_response status="200"><target id="t1"><name>a'), false)
  assert.equal(isCompleteGmpResponse('<authenticate_response status="200" status_'), false)
  assert.equal(isCompleteGmpResponse(''), false)
})

// --- _shared helpers --------------------------------------------------------

test('buildTargetInput normalizes hosts and defaults the port list', () => {
  const input = buildTargetInput({ name: '  Prod  ', hosts: '10.0.0.1\n10.0.0.2, 10.0.0.3' })
  assert.equal(input.name, 'Prod')
  assert.equal(input.hosts, '10.0.0.1, 10.0.0.2, 10.0.0.3')
  assert.equal(input.portListId, PORT_LIST_ALL_IANA_TCP)
})

test('normalizeHosts is order- and separator-insensitive', () => {
  assert.equal(normalizeHosts('10.0.0.2, 10.0.0.1'), normalizeHosts('10.0.0.1\n10.0.0.2'))
})

test('findTargetByName matches on the trimmed name', () => {
  const targets = parseTargets('<get_targets_response><target id="t1"><name>Prod Web</name><hosts>1.1.1.1</hosts></target></get_targets_response>')
  assert.equal(findTargetByName(targets, 'Prod Web')?.id, 't1')
  assert.equal(findTargetByName(targets, 'Nope'), null)
})
