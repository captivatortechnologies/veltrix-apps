import type { CanvasItemSnapshot, ComponentRef, PlatformDatabaseClient } from '@veltrixsecops/app-sdk'

type Row = Record<string, any>

export const CUSTOMER = '00000000-0000-4000-8000-000000000001'
export const COMPONENT: ComponentRef = { id: '00000000-0000-4000-8000-0000000000c1', hostname: '123456789012', port: '', type: ['aws-account'], toolId: 't' }

export interface FakeDb extends PlatformDatabaseClient {
  tables: { policies: Row[]; accounts: Row[]; runs: Row[]; exceptions: Row[]; schedules: Row[] }
  calls: string[]
}

let counter = 0
const nextId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
const stamp = (): string => new Date().toISOString()

function upsertBy(rows: Row[], match: (r: Row) => boolean, make: () => Row, merge: (r: Row) => void): Row {
  const found = rows.find(match)
  if (found) {
    merge(found)
    return found
  }
  const created = make()
  rows.push(created)
  return created
}

export function createFakeDb(): FakeDb {
  const tables: FakeDb['tables'] = { policies: [], accounts: [], runs: [], exceptions: [], schedules: [] }
  const calls: string[] = []

  const query = async (sql: string, ...p: any[]): Promise<any> => {
    const s = sql.replace(/\s+/g, ' ')
    calls.push(s)
    if (s.startsWith('INSERT INTO cgov_policy (')) {
      const [customer, canvas, name, model, yaml, actionClass, enforcement] = p
      return [upsertBy(tables.policies, (r) => r.customer_id === customer && r.name === name,
        () => ({ id: nextId(), customer_id: customer, canvas_id: canvas, name, model: JSON.parse(model), compiled_yaml: yaml, action_class: actionClass, enforcement, version: 1, created_at: stamp(), updated_at: stamp() }),
        (r) => Object.assign(r, { canvas_id: canvas, model: JSON.parse(model), compiled_yaml: yaml, action_class: actionClass, enforcement, version: r.version + 1 }))]
    }
    if (s.startsWith('SELECT * FROM cgov_policy WHERE customer_id = $1::uuid AND name = $2')) {
      return tables.policies.filter((r) => r.customer_id === p[0] && r.name === p[1])
    }
    if (s.startsWith('SELECT * FROM cgov_policy WHERE customer_id = $1::uuid ORDER BY name')) {
      return tables.policies.filter((r) => r.customer_id === p[0]).sort((a, b) => a.name.localeCompare(b.name))
    }
    if (s.startsWith('INSERT INTO cgov_policy_account')) {
      const [customer, policyId, componentId, ref, regions] = p
      if (!tables.policies.some((r) => r.id === policyId && r.customer_id === customer)) return []
      return [upsertBy(tables.accounts, (r) => r.policy_id === policyId && r.component_id === componentId,
        () => ({ id: nextId(), customer_id: customer, policy_id: policyId, component_id: componentId, account_ref: ref, regions, created_at: stamp() }),
        (r) => Object.assign(r, { account_ref: ref ?? r.account_ref, regions }))]
    }
    if (s.startsWith('SELECT * FROM cgov_policy_account') && s.includes('component_id = $3')) {
      return tables.accounts.filter((r) => r.customer_id === p[0] && r.policy_id === p[1] && r.component_id === p[2])
    }
    if (s.startsWith('SELECT * FROM cgov_policy_account')) return tables.accounts.filter((r) => r.customer_id === p[0] && r.policy_id === p[1])
    if (s.startsWith('SELECT * FROM cgov_run')) {
      return tables.runs.filter((r) => r.customer_id === p[0] && (p[1] === null || r.policy_id === p[1])).slice(0, p[2])
    }
    if (s.startsWith('INSERT INTO cgov_exception')) {
      const [customer, canvas, policy, resource, reason, approver, expires] = p
      return [upsertBy(tables.exceptions, (r) => r.customer_id === customer && r.policy_name === policy && r.resource_id === resource,
        () => ({ id: nextId(), customer_id: customer, canvas_id: canvas, policy_name: policy, resource_id: resource, reason, approver, expires_at: expires, created_at: stamp() }),
        (r) => Object.assign(r, { canvas_id: canvas, reason, approver, expires_at: expires }))]
    }
    if (s.startsWith('SELECT * FROM cgov_exception') && s.includes('expires_at >')) {
      return tables.exceptions.filter((r) => r.customer_id === p[0] && r.policy_name === p[1] && Date.parse(r.expires_at) > Date.parse(p[2]))
    }
    if (s.startsWith('SELECT * FROM cgov_exception')) {
      return tables.exceptions.filter((r) => r.customer_id === p[0] && (p[1] === null || r.policy_name === p[1]))
    }
    if (s.startsWith('INSERT INTO cgov_schedule')) {
      const [customer, canvas, policy, cron, enabled, enforcement, next] = p
      return [upsertBy(tables.schedules, (r) => r.customer_id === customer && r.policy_name === policy,
        () => ({ id: nextId(), customer_id: customer, canvas_id: canvas, policy_name: policy, cron, enabled, enforcement, next_run_at: next, created_at: stamp(), updated_at: stamp() }),
        (r) => Object.assign(r, { canvas_id: canvas, cron, enabled, enforcement, next_run_at: next }))]
    }
    if (s.startsWith('SELECT * FROM cgov_schedule')) return tables.schedules.filter((r) => r.customer_id === p[0])
    throw new Error(`FakeDb: unhandled query ${s}`)
  }

  const removeWhere = (rows: Row[], keep: (r: Row) => boolean): number => {
    const before = rows.length
    const kept = rows.filter(keep)
    rows.splice(0, rows.length, ...kept)
    return before - kept.length
  }

  const execute = async (sql: string, ...p: any[]): Promise<number> => {
    const s = sql.replace(/\s+/g, ' ')
    calls.push(s)
    if (s.startsWith('DELETE FROM cgov_policy WHERE id')) {
      removeWhere(tables.accounts, (r) => r.policy_id !== p[0])
      return removeWhere(tables.policies, (r) => r.id !== p[0])
    }
    if (s.startsWith('DELETE FROM cgov_policy_account')) {
      return removeWhere(tables.accounts, (r) => !(r.policy_id === p[1] && r.component_id === p[2]))
    }
    if (s.startsWith('DELETE FROM cgov_exception')) return removeWhere(tables.exceptions, (r) => r.id !== p[0])
    if (s.startsWith('DELETE FROM cgov_schedule')) return removeWhere(tables.schedules, (r) => r.id !== p[0])
    throw new Error(`FakeDb: unhandled statement ${s}`)
  }

  return { tables, calls, $queryRawUnsafe: query, $executeRawUnsafe: execute } as unknown as FakeDb
}

export function item(fields: Record<string, unknown>, name = String(fields.name ?? fields.policy ?? 'item')): CanvasItemSnapshot {
  return { id: `id-${name}`, name, fields }
}

export function canvasOf(items: CanvasItemSnapshot[]): any {
  return { id: 'c', canvasId: '00000000-0000-4000-8000-0000000000ca', version: 1, name: 'c', toolType: 'cloud-governance', entityType: 'x', items, sections: items, snapshot: {} }
}

export function ctxFor(items: CanvasItemSnapshot[], db?: FakeDb, extra: Record<string, unknown> = {}): any {
  return { appId: 'cloud-governance', customerId: CUSTOMER, canvas: canvasOf(items), deployedConfig: canvasOf(items), component: COMPONENT, db, ...extra }
}

export const goodPolicyFields = {
  name: 'stopped-ec2',
  resource: 'ec2',
  enforcement: 'auto',
  filters: '[{"type":"value","key":"State.Name","value":"stopped"}]',
  actions: '[{"type":"mark-for-op","op":"stop","days":7}]',
}
