// ========================================================================
// Tests: @veltrixsecops/app-sdk/ui — SearchBox
// ========================================================================

import * as React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { HOST_RUNTIME_GLOBAL } from '../../client'
import { SearchBox } from '../index'

function installFakeHost() {
  const ui: Record<string, unknown> = {
    SearchBox: (props: { value: string; onChange: (v: string) => void }) => (
      <input data-testid="host-search-box" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    ),
  }
  ;(globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL] = {
    react: React,
    authFetch: () => Promise.resolve(new Response()),
    AppContext: React.createContext(null),
    sdk: {},
    ui,
  }
}

function uninstallHost() {
  delete (globalThis as Record<string, unknown>)[HOST_RUNTIME_GLOBAL]
}

afterEach(() => {
  uninstallHost()
})

describe('SearchBox', () => {
  it('renders the host SearchBox when present', () => {
    installFakeHost()
    render(<SearchBox value="splunk" onChange={() => {}} />)
    expect(screen.getByTestId('host-search-box')).toHaveValue('splunk')
  })

  it('fallback: renders a bare accessible <input type="search"> that calls onChange', () => {
    let changedTo: string | undefined
    render(<SearchBox value="" onChange={(v) => (changedTo = v)} placeholder="Search apps…" />)
    const input = screen.getByRole('searchbox', { name: 'Search apps…' })
    fireEvent.change(input, { target: { value: 'crowdstrike' } })
    expect(changedTo).toBe('crowdstrike')
  })

  it('fallback: falls back to "Search" as the accessible name when no placeholder or aria-label is given', () => {
    render(<SearchBox value="" onChange={() => {}} />)
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument()
  })

  it('fallback: reflects the disabled prop without throwing', () => {
    render(<SearchBox value="" onChange={() => {}} disabled />)
    expect(screen.getByRole('searchbox')).toBeDisabled()
  })
})
