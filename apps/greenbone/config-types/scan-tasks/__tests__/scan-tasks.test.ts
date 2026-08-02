import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  buildGetTasksCommand,
  buildGetScanConfigsCommand,
  buildGetScannersCommand,
  buildCreateTaskCommand,
  buildModifyTaskCommand,
  buildDeleteTaskCommand,
  parseTasks,
  parseScanConfigs,
  parseScanners,
  parseTargets,
  parseSchedules,
} from '../../../lib/greenboneApi'
import { buildTaskFields, findTaskByName, resolveRef, resolveTaskRefs, type LiveLookups } from '../_shared'

// Live-socket handlers (deploy/rollback/health/drift) are unmockable (house
// convention); these tests cover the pure seams: validate.ts, the GMP XML command
// assembly + response parsing, and the by-name/by-UUID foreign-key resolution.

// --- validate ---------------------------------------------------------------

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Weekly Prod', target: 'Prod Web', config: 'Full and fast', scanner: 'OpenVAS Default' }

test('validate accepts a good task', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name / target / config / scanner', async () => {
  assert.ok((await validate(ctxOf([{ ...good, name: '' }]))).errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok((await validate(ctxOf([{ ...good, target: '' }]))).errors.some((e) => e.code === 'EMPTY_TARGET'))
  assert.ok((await validate(ctxOf([{ ...good, config: '' }]))).errors.some((e) => e.code === 'EMPTY_CONFIG'))
  assert.ok((await validate(ctxOf([{ ...good, scanner: '' }]))).errors.some((e) => e.code === 'EMPTY_SCANNER'))
})

test('validate warns on a duplicate task name', async () => {
  const res = await validate(ctxOf([good, { ...good, target: 'DB Tier' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- command builders -------------------------------------------------------

test('buildGetTasksCommand carries usage_type=scan and rows=-1', () => {
  assert.equal(buildGetTasksCommand(), '<get_tasks usage_type="scan" filter="rows=-1"/>')
})

test('buildGetScanConfigsCommand / buildGetScannersCommand shapes', () => {
  assert.equal(buildGetScanConfigsCommand(), '<get_configs usage_type="scan" filter="rows=-1"/>')
  assert.equal(buildGetScannersCommand(), '<get_scanners filter="rows=-1"/>')
})

test('buildCreateTaskCommand emits usage_type + id-bearing config/target/scanner', () => {
  const xml = buildCreateTaskCommand({ name: 'Weekly', configId: 'cfg-1', targetId: 'tgt-1', scannerId: 'scn-1', scheduleId: 'sch-1', comment: 'q1' })
  assert.ok(xml.startsWith('<create_task>'))
  assert.ok(xml.includes('<name>Weekly</name>'))
  assert.ok(xml.includes('<usage_type>scan</usage_type>'))
  assert.ok(xml.includes('<config id="cfg-1"/>'))
  assert.ok(xml.includes('<target id="tgt-1"/>'))
  assert.ok(xml.includes('<scanner id="scn-1"/>'))
  assert.ok(xml.includes('<schedule id="sch-1"/>'))
  assert.ok(xml.includes('<comment>q1</comment>'))
})

test('buildCreateTaskCommand omits a schedule id of 0 (no schedule)', () => {
  const xml = buildCreateTaskCommand({ name: 'W', configId: 'c', targetId: 't', scannerId: 's', scheduleId: '0' })
  assert.ok(!xml.includes('<schedule'))
})

test('buildModifyTaskCommand targets by task_id and only sends provided fields', () => {
  const xml = buildModifyTaskCommand('task-1', { name: 'W', targetId: 'tgt-2' })
  assert.equal(xml, '<modify_task task_id="task-1"><name>W</name><target id="tgt-2"/></modify_task>')
})

test('buildModifyTaskCommand can clear a schedule with id 0', () => {
  const xml = buildModifyTaskCommand('task-1', { scheduleId: '0' })
  assert.equal(xml, '<modify_task task_id="task-1"><schedule id="0"/></modify_task>')
})

test('buildDeleteTaskCommand sets ultimate', () => {
  assert.equal(buildDeleteTaskCommand('t1', true), '<delete_task task_id="t1" ultimate="1"/>')
})

// --- response parsing (nested foreign keys) ---------------------------------

const TASKS_XML = `<get_tasks_response status="200" status_text="OK">
  <task id="task-aaaa">
    <name>Weekly Prod</name>
    <comment>quarterly</comment>
    <owner><name>admin</name></owner>
    <target id="tgt-1"><name>Prod Web</name><trash>0</trash></target>
    <config id="cfg-1"><name>Full and fast</name><trash>0</trash></config>
    <scanner id="scn-1"><name>OpenVAS Default</name><type>2</type></scanner>
    <schedule id="sch-1"><name>Weekly</name></schedule>
  </task>
  <task id="task-bbbb">
    <name>Ad Hoc</name>
    <target id="tgt-2"><name>DB Tier</name></target>
    <config id="cfg-2"><name>Base</name></config>
    <scanner id="scn-1"><name>OpenVAS Default</name></scanner>
    <schedule id="0"/>
  </task>
</get_tasks_response>`

test('parseTasks extracts the task name and each nested foreign key id + name', () => {
  const tasks = parseTasks(TASKS_XML)
  assert.equal(tasks.length, 2)
  const t = tasks[0]
  assert.equal(t.id, 'task-aaaa')
  assert.equal(t.name, 'Weekly Prod') // NOT the owner's <name>admin</name>
  assert.equal(t.comment, 'quarterly')
  assert.equal(t.targetId, 'tgt-1')
  assert.equal(t.targetName, 'Prod Web')
  assert.equal(t.configName, 'Full and fast')
  assert.equal(t.scannerName, 'OpenVAS Default')
  assert.equal(t.scheduleId, 'sch-1')
  assert.equal(t.scheduleName, 'Weekly')
})

test('parseTasks reads a self-closing empty schedule as id 0', () => {
  const t = parseTasks(TASKS_XML)[1]
  assert.equal(t.scheduleId, '0')
  assert.equal(t.scheduleName, '')
})

test('parseScanConfigs / parseScanners read id + name', () => {
  const configs = parseScanConfigs('<get_configs_response><config id="c1"><name>Full and fast</name></config><config id="c2"><name>Base</name></config></get_configs_response>')
  assert.deepEqual(configs.map((c) => c.name), ['Full and fast', 'Base'])
  const scanners = parseScanners('<get_scanners_response><scanner id="s1"><name>OpenVAS Default</name></scanner></get_scanners_response>')
  assert.equal(scanners[0].id, 's1')
})

// --- foreign-key resolution by name / UUID ----------------------------------

const UUID = '08b69003-5fc2-4037-a479-93b440211c73'

function lookups(): LiveLookups {
  return {
    targets: parseTargets('<r><target id="tgt-1"><name>Prod Web</name><hosts>1.1.1.1</hosts></target></r>'),
    configs: parseScanConfigs('<r><config id="cfg-1"><name>Full and fast</name></config></r>'),
    scanners: parseScanners(`<r><scanner id="${UUID}"><name>OpenVAS Default</name></scanner></r>`),
    schedules: parseSchedules('<r><schedule id="sch-1"><name>Weekly</name></schedule></r>'),
  }
}

test('resolveRef matches by name and by pasted UUID', () => {
  const list = [{ id: UUID, name: 'OpenVAS Default' }]
  assert.equal(resolveRef(list, 'OpenVAS Default'), UUID)
  assert.equal(resolveRef(list, UUID), UUID)
  assert.equal(resolveRef(list, 'Nope'), null)
})

test('resolveTaskRefs resolves required refs and an optional schedule', () => {
  const fields = buildTaskFields({ name: 'Weekly Prod', target: 'Prod Web', config: 'Full and fast', scanner: UUID, schedule: 'Weekly' })
  const { resolved, missing } = resolveTaskRefs(fields, lookups())
  assert.equal(missing.length, 0)
  assert.deepEqual(resolved, { configId: 'cfg-1', targetId: 'tgt-1', scannerId: UUID, scheduleId: 'sch-1' })
})

test('resolveTaskRefs reports every unresolved reference by kind + name', () => {
  const fields = buildTaskFields({ name: 'X', target: 'Ghost', config: 'Full and fast', scanner: 'Missing Scanner' })
  const { resolved, missing } = resolveTaskRefs(fields, lookups())
  assert.equal(resolved, null)
  assert.ok(missing.some((m) => m.includes('target "Ghost"')))
  assert.ok(missing.some((m) => m.includes('scanner "Missing Scanner"')))
  assert.ok(!missing.some((m) => m.includes('scan config')))
})

test('buildTaskFields defaults config and scanner to the common feed names', () => {
  const fields = buildTaskFields({ name: 'X', target: 'Prod Web' })
  assert.equal(fields.config, 'Full and fast')
  assert.equal(fields.scanner, 'OpenVAS Default')
})

test('findTaskByName matches on the trimmed name', () => {
  assert.equal(findTaskByName(parseTasks(TASKS_XML), 'Ad Hoc')?.id, 'task-bbbb')
  assert.equal(findTaskByName(parseTasks(TASKS_XML), 'Nope'), null)
})
