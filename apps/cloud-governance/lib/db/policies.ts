import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import type { ActionClass, Enforcement, GovernancePolicy } from '../model/types'
import { mapPolicy, mapPolicyAccount, type PolicyAccountDto, type PolicyDto } from './mappers'

export interface UpsertPolicyInput {
  canvasId?: string | null
  model: GovernancePolicy
  compiledYaml: string | null
  actionClass: ActionClass
  enforcement: Enforcement
}

export async function upsertPolicy(db: PlatformDatabaseClient, customerId: string, input: UpsertPolicyInput): Promise<PolicyDto> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `INSERT INTO cgov_policy (customer_id, canvas_id, name, model, compiled_yaml, action_class, enforcement)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (customer_id, name) DO UPDATE SET
       canvas_id = EXCLUDED.canvas_id, model = EXCLUDED.model, compiled_yaml = EXCLUDED.compiled_yaml,
       action_class = EXCLUDED.action_class, enforcement = EXCLUDED.enforcement,
       version = cgov_policy.version + 1, updated_at = now()
     RETURNING *`,
    customerId, input.canvasId ?? null, input.model.name, JSON.stringify(input.model), input.compiledYaml, input.actionClass, input.enforcement)
  return mapPolicy(rows[0])
}

export async function getPolicy(db: PlatformDatabaseClient, customerId: string, id: string): Promise<PolicyDto | null> {
  const rows = await db.$queryRawUnsafe<any[]>('SELECT * FROM cgov_policy WHERE id = $1::uuid AND customer_id = $2::uuid', id, customerId)
  return rows[0] ? mapPolicy(rows[0]) : null
}

export async function getPolicyByName(db: PlatformDatabaseClient, customerId: string, name: string): Promise<PolicyDto | null> {
  const rows = await db.$queryRawUnsafe<any[]>('SELECT * FROM cgov_policy WHERE customer_id = $1::uuid AND name = $2', customerId, name)
  return rows[0] ? mapPolicy(rows[0]) : null
}

export async function listPolicies(db: PlatformDatabaseClient, customerId: string, canvasId?: string | null): Promise<PolicyDto[]> {
  const rows = canvasId
    ? await db.$queryRawUnsafe<any[]>('SELECT * FROM cgov_policy WHERE customer_id = $1::uuid AND canvas_id = $2::uuid ORDER BY name', customerId, canvasId)
    : await db.$queryRawUnsafe<any[]>('SELECT * FROM cgov_policy WHERE customer_id = $1::uuid ORDER BY name', customerId)
  return rows.map(mapPolicy)
}

export async function deletePolicy(db: PlatformDatabaseClient, customerId: string, id: string): Promise<number> {
  return db.$executeRawUnsafe('DELETE FROM cgov_policy WHERE id = $1::uuid AND customer_id = $2::uuid', id, customerId)
}

export interface UpsertPolicyAccountInput {
  policyId: string
  componentId: string
  accountRef?: string | null
  regions?: string[]
}

export async function upsertPolicyAccount(db: PlatformDatabaseClient, customerId: string, input: UpsertPolicyAccountInput): Promise<PolicyAccountDto> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `INSERT INTO cgov_policy_account (customer_id, policy_id, component_id, account_ref, regions)
     SELECT $1::uuid, p.id, $3::uuid, $4, $5::text[] FROM cgov_policy p WHERE p.id = $2::uuid AND p.customer_id = $1::uuid
     ON CONFLICT (policy_id, component_id) DO UPDATE SET
       account_ref = COALESCE(EXCLUDED.account_ref, cgov_policy_account.account_ref), regions = EXCLUDED.regions
     RETURNING *`,
    customerId, input.policyId, input.componentId, input.accountRef ?? null, input.regions ?? [])
  if (!rows[0]) throw Object.assign(new Error('Policy not found'), { statusCode: 404 })
  return mapPolicyAccount(rows[0])
}

export async function listPolicyAccounts(db: PlatformDatabaseClient, customerId: string, policyId: string): Promise<PolicyAccountDto[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM cgov_policy_account WHERE customer_id = $1::uuid AND policy_id = $2::uuid ORDER BY created_at', customerId, policyId)
  return rows.map(mapPolicyAccount)
}

export async function getPolicyAccount(db: PlatformDatabaseClient, customerId: string, policyId: string, componentId: string): Promise<PolicyAccountDto | null> {
  const rows = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM cgov_policy_account WHERE customer_id = $1::uuid AND policy_id = $2::uuid AND component_id = $3::uuid', customerId, policyId, componentId)
  return rows[0] ? mapPolicyAccount(rows[0]) : null
}

export async function deletePolicyAccountsForComponent(db: PlatformDatabaseClient, customerId: string, componentId: string): Promise<number> {
  const active = await db.$queryRawUnsafe<any[]>(
    'SELECT id FROM cgov_policy_account WHERE customer_id = $1::uuid AND component_id = $2::uuid AND active_run_id IS NOT NULL FOR UPDATE',
    customerId, componentId)
  if (active.length > 0) throw Object.assign(new Error('A run is in progress for this account. Wait for it to finish before removing the account.'), { statusCode: 409 })
  return db.$executeRawUnsafe('DELETE FROM cgov_policy_account WHERE customer_id = $1::uuid AND component_id = $2::uuid', customerId, componentId)
}

export async function deletePolicyAccount(db: PlatformDatabaseClient, customerId: string, policyId: string, componentId: string): Promise<number> {
  return db.$executeRawUnsafe(
    'DELETE FROM cgov_policy_account WHERE customer_id = $1::uuid AND policy_id = $2::uuid AND component_id = $3::uuid',
    customerId, policyId, componentId)
}
