import React from 'react'
import { Button, Input, Select } from '../ui'
import { tokens } from './detail/shared'
import {
  type ClusterPlacement,
  type PlacementGranularity,
  type PlacementSite,
  PLACEMENT_GRANULARITY_OPTIONS,
} from './types'
import { allocateNodesBySite, validatePlacement } from './placement'

// =============================================================================
// Per-cluster placement editor: single-site, or multi-site spread by percent
// across availability zones (same region) or regions. Used for the indexer and
// search-head clusters only — every other tier is always in the main region.
// =============================================================================

interface ClusterPlacementFieldProps {
  label: string
  placement: ClusterPlacement
  /** Node count for this cluster — drives the live "→ N nodes" preview. */
  nodeCount: number
  /** The deployment's main region — the single-site home and the AZ prefix. */
  primaryRegion: string
  /** Cloud provider code (aws|azure|gcp|hetzner) — zone naming differs per cloud. */
  providerCode?: string
  /** Cloud regions offered when spreading by region. */
  regionOptions: Array<{ value: string; label: string }>
  onChange: (placement: ClusterPlacement) => void
}

const MODE_OPTIONS = [
  { value: 'single', label: 'Single site — all nodes in the main region' },
  { value: 'multi-site', label: 'Multi-site — spread nodes by percent' },
]

// Availability-zone naming differs per cloud: AWS `us-east-1a`, GCP `us-central1-a`,
// Azure numeric zones (1/2/3). Hetzner has no in-location AZs — use region granularity.
const AWS_AZ_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f']
const GCP_AZ_LETTERS = ['a', 'b', 'c', 'd', 'f']
const AZURE_ZONES = ['1', '2', '3']

function azOptionsFor(providerCode: string | undefined, region: string): Array<{ value: string; label: string }> {
  const code = (providerCode || 'aws').toLowerCase()
  const base = region || 'region'
  if (code === 'azure') return AZURE_ZONES.map((z) => ({ value: z, label: `Zone ${z}` }))
  if (code === 'gcp') return GCP_AZ_LETTERS.map((l) => ({ value: `${base}-${l}`, label: `${base}-${l}` }))
  return AWS_AZ_LETTERS.map((l) => ({ value: `${base}${l}`, label: `${base}${l}` }))
}

/** Integer percents summing to 100, with the remainder on the first sites. */
function evenPercents(count: number): number[] {
  if (count <= 0) return []
  const base = Math.floor(100 / count)
  const remainder = 100 - base * count
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
}

function defaultSites(
  granularity: PlacementGranularity,
  primaryRegion: string,
  providerCode: string | undefined,
  regionOptions: Array<{ value: string; label: string }>,
): PlacementSite[] {
  const [p0, p1] = evenPercents(2)
  if (granularity === 'az') {
    const az = azOptionsFor(providerCode, primaryRegion)
    return [
      { site: az[0]?.value ?? `${primaryRegion}a`, percent: p0 },
      { site: az[1]?.value ?? `${primaryRegion}b`, percent: p1 },
    ]
  }
  const regions = regionOptions.map((o) => o.value).filter(Boolean)
  const first = primaryRegion || regions[0] || ''
  const second = regions.find((r) => r !== first) ?? ''
  return [
    { site: first, percent: p0 },
    { site: second, percent: p1 },
  ]
}

export const ClusterPlacementField: React.FC<ClusterPlacementFieldProps> = ({
  label,
  placement,
  nodeCount,
  primaryRegion,
  providerCode,
  regionOptions,
  onChange,
}) => {
  const multi = placement.mode === 'multi-site'
  const granularity: PlacementGranularity = placement.granularity ?? 'az'
  const sites = placement.sites ?? []
  const siteOptions = granularity === 'az' ? azOptionsFor(providerCode, primaryRegion) : regionOptions

  const emit = (next: PlacementSite[]) => onChange({ mode: 'multi-site', granularity, sites: next })

  const setMode = (mode: string) => {
    if (mode !== 'multi-site') return onChange({ mode: 'single' })
    onChange({
      mode: 'multi-site',
      granularity,
      sites: sites.length >= 2 ? sites : defaultSites(granularity, primaryRegion, providerCode, regionOptions),
    })
  }

  const setGranularity = (value: string) => {
    const g = value as PlacementGranularity
    // Sites are granularity-specific (AZ ids vs region codes) — reset to defaults.
    onChange({ mode: 'multi-site', granularity: g, sites: defaultSites(g, primaryRegion, providerCode, regionOptions) })
  }

  const updateSite = (i: number, patch: Partial<PlacementSite>) =>
    emit(sites.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  const addSite = () => {
    const used = new Set(sites.map((s) => s.site))
    const nextSite = siteOptions.map((o) => o.value).find((v) => !used.has(v)) ?? ''
    emit([...sites, { site: nextSite, percent: 0 }])
  }

  const removeSite = (i: number) => emit(sites.filter((_, idx) => idx !== i))

  const distributeEvenly = () => {
    const percents = evenPercents(sites.length)
    emit(sites.map((s, i) => ({ ...s, percent: percents[i] })))
  }

  const allocation = multi ? allocateNodesBySite(nodeCount, sites) : []
  const validationError = multi ? validatePlacement(placement, nodeCount) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Select label={label} value={placement.mode} onChange={setMode} options={MODE_OPTIONS} />

      {multi ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 12,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            background: tokens.surface2,
          }}
        >
          <Select
            label="Spread across"
            value={granularity}
            onChange={setGranularity}
            options={[...PLACEMENT_GRANULARITY_OPTIONS]}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sites.map((site, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 92px auto auto', gap: 8, alignItems: 'end' }}>
                <Select
                  label={i === 0 ? (granularity === 'az' ? 'Zone' : 'Region') : undefined}
                  value={site.site}
                  onChange={(value) => updateSite(i, { site: value })}
                  options={siteOptions}
                  placeholder="Select…"
                />
                <Input
                  label={i === 0 ? 'Share %' : undefined}
                  type="number"
                  min={0}
                  max={100}
                  value={String(site.percent)}
                  onChange={(e) => updateSite(i, { percent: Number(e.target.value) || 0 })}
                  fullWidth
                />
                <span style={{ fontSize: 12, color: tokens.muted, paddingBottom: 10, whiteSpace: 'nowrap' }}>
                  → {allocation[i]?.count ?? 0} node{(allocation[i]?.count ?? 0) === 1 ? '' : 's'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSite(i)}
                  disabled={sites.length <= 2}
                  aria-label={`Remove site ${i + 1}`}
                  style={{ marginBottom: 4 }}
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={addSite} disabled={sites.length >= siteOptions.length}>
              Add site
            </Button>
            <Button variant="ghost" size="sm" onClick={distributeEvenly}>
              Distribute evenly
            </Button>
          </div>

          {validationError ? (
            <p style={{ margin: 0, fontSize: 12, color: tokens.danger }}>{validationError}</p>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>
              {sites.length} sites · {allocation.reduce((n, a) => n + a.count, 0)} of {nodeCount} nodes placed.
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
