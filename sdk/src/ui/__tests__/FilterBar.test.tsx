// ========================================================================
// Tests: @veltrixsecops/app-sdk/ui — FilterBar
// ========================================================================

import * as React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { HOST_RUNTIME_GLOBAL } from '../../client'
import { FilterBar, type FilterDefinition } from '../index'

function installFakeHost() {
  const ui: Record<string, unknown> = {
    FilterBar: (props: { filters: FilterDefinition[] }) => (
      <div data-testid="host-filter-bar">{props.filters.length} filters</div>
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

const filters: FilterDefinition[] = [
  {
    key: 'vendor',
    label: 'Vendor',
    options: [
      { value: 'splunk', label: 'Splunk' },
      { value: 'crowdstrike', label: 'CrowdStrike' },
    ],
    value: null,
    onChange: () => {},
    alwaysVisible: true,
  },
]

describe('FilterBar', () => {
  it('renders the host FilterBar when present', () => {
    installFakeHost()
    render(<FilterBar filters={filters} />)
    expect(screen.getByTestId('host-filter-bar')).toHaveTextContent('1 filters')
  })

  it('fallback: renders every filter as a native, always-visible <select> that calls onChange', () => {
    let changedTo: string | null | undefined
    const fallbackFilters: FilterDefinition[] = [
      { ...filters[0], onChange: (v) => (changedTo = v) },
    ]
    render(<FilterBar filters={fallbackFilters} />)

    const select = screen.getByLabelText('Vendor') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'crowdstrike' } })
    expect(changedTo).toBe('crowdstrike')
  })

  it('fallback: renders the search input and calls search.onChange, without throwing', () => {
    let searchValue: string | undefined
    render(
      <FilterBar
        filters={filters}
        search={{ value: '', onChange: (v) => (searchValue = v), placeholder: 'Search apps…' }}
      />,
    )
    const search = screen.getByRole('searchbox', { name: 'Search apps…' })
    fireEvent.change(search, { target: { value: 'okta' } })
    expect(searchValue).toBe('okta')
  })
})
