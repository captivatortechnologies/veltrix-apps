import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { HOST_RUNTIME_GLOBAL } from '../../client'
import { ByolInfrastructureDetail } from '../ByolInfrastructureDetail'
import type { ByolInfrastructure } from '../types'
import type { ConfirmationOptions } from '../../ui'

// =============================================================================
// Danger-zone confirmations (Destroy / Delete) — these used to call the native
// window.confirm(). They now go through the SDK's shared useConfirmDialog hook,
// which delegates to the platform's real (portaled, themed) confirmation dialog
// inside Veltrix and fails closed (resolves false, no native dialog) outside it.
//
// Since useConfirmDialog's actual dialog UI (render, Escape-to-cancel, backdrop
// click) is the HOST's implementation — already covered by
// sdk/src/ui/__tests__/ui.test.tsx — these tests assert the CONSUMER contract:
// the view calls confirm() with the right title/message/variant, proceeds only
// when it resolves true, does nothing on cancel/false, and never touches
// window.confirm/alert directly.
// =============================================================================

const RUNNING: ByolInfrastructure = {
  id: 'i1',
  name: 'BYOL001',
  deploymentType: 'distributed',
  indexerCount: 3,
  searchHeadCount: 2,
  status: 'running',
  hosting_type: 'AWS',
  cloudProviderId: 'cp1',
  region: 'us-east-1',
}

interface FetchCall {
  url: string
  method: string
}

function installFakeHostWithConfirm(confirmImpl: (options: ConfirmationOptions) => Promise<boolean>) {
  const confirm = vi.fn(confirmImpl)
  const ui: Record<string, unknown> = {
    useConfirmDialog: () => ({ confirm }),
  }
  ;(globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL] = {
    react: React,
    authFetch: (input: string, init?: RequestInit) => fetch(input, init),
    AppContext: React.createContext(null),
    sdk: {},
    ui,
  }
  return confirm
}

function uninstallHost() {
  delete (globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL]
}

/** Routes GET (infra/resources/deployments) vs the destroy POST / delete DELETE, recording every call. */
function stubFetch(calls: FetchCall[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST' && url.endsWith('/destroy')) {
        return { ok: true, status: 202, json: async () => ({ infrastructure: { ...RUNNING, status: 'destroying' } }) }
      }
      if (method === 'DELETE') {
        return { ok: true, status: 204, json: async () => ({}) }
      }
      if (url.endsWith('/resources')) return { ok: true, status: 200, json: async () => [] }
      if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => [] }
      return { ok: true, status: 200, json: async () => RUNNING }
    }) as unknown as typeof fetch,
  )
}

async function renderOnSettings(props: Partial<React.ComponentProps<typeof ByolInfrastructureDetail>> = {}) {
  const onDeleted = props.onDeleted ?? vi.fn()
  const onChanged = props.onChanged ?? vi.fn()
  render(
    <ByolInfrastructureDetail
      apiBase="/api/apps/x/byol"
      initialInfra={RUNNING}
      onBack={() => {}}
      onEdit={() => {}}
      onDeleted={onDeleted}
      onChanged={onChanged}
      {...props}
    />,
  )
  await waitFor(() => expect(screen.getByTitle('Settings')).toBeTruthy())
  fireEvent.click(screen.getByTitle('Settings'))
  await waitFor(() => expect(screen.getByText('Destroy infrastructure')).toBeTruthy())
  return { onDeleted, onChanged }
}

describe('Danger zone — Destroy / Delete confirmation', () => {
  // `vi.spyOn`'s overloaded generic return type doesn't narrow cleanly to a
  // hoisted `let` — these are only ever used for mockRestore()/toHaveBeenCalled().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let windowConfirmSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let windowAlertSpy: any

  beforeEach(() => {
    windowConfirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm() must not be called — use the shared confirmation dialog instead')
    })
    windowAlertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {
      throw new Error('window.alert() must not be called — use the shared confirmation dialog instead')
    })
  })

  afterEach(() => {
    windowConfirmSpy.mockRestore()
    windowAlertSpy.mockRestore()
    uninstallHost()
    vi.unstubAllGlobals()
  })

  it('never calls the native window.confirm/alert dialogs for Destroy or Delete', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    installFakeHostWithConfirm(async () => true)

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(true))

    expect(windowConfirmSpy).not.toHaveBeenCalled()
    expect(windowAlertSpy).not.toHaveBeenCalled()
  })

  it('Destroy: asks for confirmation with a danger variant, and only POSTs /destroy when confirmed', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const confirm = installFakeHostWithConfirm(async () => true)

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Destroy infrastructure',
      message: 'Destroy all resources for "BYOL001"? This cannot be undone.',
      confirmText: 'Destroy',
      variant: 'danger',
    })

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(true))
  })

  it('Destroy: does NOT call /destroy when the user cancels the confirmation', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    installFakeHostWithConfirm(async () => false)

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))

    // Give the async confirm() a tick to resolve.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(false)
  })

  it('Delete: asks for confirmation with a danger variant, and only DELETEs the record when confirmed', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const confirm = installFakeHostWithConfirm(async () => true)

    const { onDeleted } = await renderOnSettings()
    fireEvent.click(screen.getByText('Delete record'))

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Delete infrastructure record',
      message: 'Delete "BYOL001"? This cannot be undone.',
      confirmText: 'Delete',
      variant: 'danger',
    })

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('Delete: does NOT delete the record when the user cancels the confirmation', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    installFakeHostWithConfirm(async () => false)

    const { onDeleted } = await renderOnSettings()
    fireEvent.click(screen.getByText('Delete record'))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('fallback (outside the platform): fails closed — no host confirmation dialog means Destroy/Delete never proceed', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    // No fake host installed — useConfirmDialog() resolves to the fail-closed fallback.

    await renderOnSettings()
    fireEvent.click(screen.getByText('Destroy infrastructure'))
    fireEvent.click(screen.getByText('Delete record'))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/destroy'))).toBe(false)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(windowConfirmSpy).not.toHaveBeenCalled()
  })
})
