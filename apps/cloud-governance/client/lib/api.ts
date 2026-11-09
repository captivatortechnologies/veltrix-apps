import { useCallback, useEffect, useRef, useState } from 'react'
import { authFetch, listInventory } from '@veltrixsecops/app-sdk/client'
import type { InventoryItem } from '@veltrixsecops/app-sdk'
import type { PolicyAccountDto, PolicyDto, RunActionDto, RunDto, RunMatchDto } from '../../lib/db/mappers'

export type { PolicyAccountDto, PolicyDto, RunActionDto, RunDto, RunMatchDto }
export type PolicyWithAccounts = PolicyDto & { accounts: PolicyAccountDto[] }
export interface RunDetail { run: RunDto; matches: RunMatchDto[]; actions: RunActionDto[]; policy: PolicyDto | null }
export interface RunRequest { componentId: string; kind: 'preview' | 'enforce'; enforcement?: 'ask' | 'auto' }
export interface RunResult { run: RunDto; dispatchPending: boolean }

const BASE = '/api/apps/cloud-governance'
export const AWS_ACCOUNT_TYPE = 'aws-account'

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
    method: init?.method,
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`)
  }
  return (await res.json()) as T
}

export const requestRun = (policyId: string, body: RunRequest) =>
  api<RunResult>(`/policies/${encodeURIComponent(policyId)}/runs`, { method: 'POST', body })

export const cancelRun = (runId: string) => api<RunDto>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })

export async function listAwsAccounts(): Promise<InventoryItem[]> {
  const items = await listInventory()
  return items.filter((item) => item.type?.includes(AWS_ACCOUNT_TYPE))
}

export interface Loadable<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[], pollMs?: (data: T | null) => number | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, deps)

  useEffect(() => {
    setLoading(true)
    void reload()
  }, [reload])

  const interval = pollMs?.(data) ?? null
  useEffect(() => {
    if (!interval) return
    const timer = window.setInterval(() => void reload(), interval)
    return () => window.clearInterval(timer)
  }, [interval, reload])

  return { data, error, loading, reload }
}
