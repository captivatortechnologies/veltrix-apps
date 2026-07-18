import React from 'react'
import { Badge } from '../../ui'
import { statusVariant, statusLabel, resourceStatusVariant, resourceStatusLabel } from '../status'
import type { ByolResource } from '../types'

// Themed tokens — bound to the platform design-system contract in
// `client/src/styles/tokens.css`. Those `--color-*` variables live on
// `:root`/`.dark`, cascade into the app subtree, and flip with light/dark, so
// consuming them here is what makes BYOL follow the active theme automatically.
//
// Two rules that the previous version got wrong:
//   1. The design tokens are *space-separated RGB triples* (e.g. `17 24 39`),
//      meant to be wrapped in `rgb(...)` — not used as bare colours.
//   2. The real names are `--color-surface[-raised/-sunken]`, `--color-border`,
//      and the `--color-content-*` text family — not `--color-text*` /
//      `--color-surface-secondary`, which never existed (so those silently fell
//      back to hardcoded light hex and never darkened).
// The triple inside each `var()` fallback keeps the component legible when it
// renders outside the platform (design tokens undefined → light theme).
//
// `primary` is the exception: `--veltrix-app-primary` is a *hex* variable the
// host injects per app (AppShell brand scope), so it is used directly.
const rgbToken = (name: string, fallback: string): string => `rgb(var(${name}, ${fallback}))`

export const tokens = {
  border: rgbToken('--color-border', '229 231 235'),
  borderStrong: rgbToken('--color-border-strong', '209 213 219'),
  surface: rgbToken('--color-surface-raised', '255 255 255'), // cards / panels / active nav
  surface2: rgbToken('--color-surface', '249 250 251'), // page surface — sidebar / insets
  text: rgbToken('--color-content-primary', '17 24 39'),
  muted: rgbToken('--color-content-secondary', '75 85 99'),
  faint: rgbToken('--color-content-tertiary', '156 163 175'),
  primary: 'var(--veltrix-app-primary, #FF6600)',
  danger: rgbToken('--color-danger', '220 38 38'),
  success: rgbToken('--color-success', '22 163 74'),
  info: rgbToken('--color-info', '14 116 144'),
  warning: rgbToken('--color-warning', '161 98 7'),
}

/** Overall infrastructure status badge. */
export const StatusPill: React.FC<{ status?: string }> = ({ status }) => (
  <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
)

/** Per-resource status badge. */
export const ResourcePill: React.FC<{ status?: string }> = ({ status }) => (
  <Badge variant={resourceStatusVariant(status)} size="sm">
    {resourceStatusLabel(status)}
  </Badge>
)

/** A labelled key/value pair used across the detail sections. */
export const Meta: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: tokens.faint }}>{label}</div>
    <div style={{ fontWeight: 600, color: tokens.text, marginTop: 2 }}>{children}</div>
  </div>
)

/** Maps a resource status to a bar colour for the progress meter. */
function barColor(status: string): string {
  switch (status) {
    case 'ready':
      return tokens.success
    case 'provisioning':
      return tokens.info
    case 'attention':
      return tokens.warning
    case 'failed':
      return tokens.danger
    default:
      return tokens.borderStrong
  }
}

/**
 * Segmented deployment-progress meter: one coloured segment per resource state,
 * plus a "N / M ready" readout. Falls back to an empty track when there are no
 * resources yet (never deployed).
 */
export const ProgressMeter: React.FC<{ resources: ByolResource[] }> = ({ resources }) => {
  const total = resources.length
  const ready = resources.filter((r) => r.status === 'ready').length
  const counts = new Map<string, number>()
  for (const r of resources) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  const order = ['ready', 'provisioning', 'attention', 'failed', 'not_started']

  return (
    <div style={{ width: 300, maxWidth: '48vw' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: tokens.muted, marginBottom: 6 }}>
        <span>Deployment progress</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {total === 0 ? 'Not deployed' : `${ready} / ${total} resources ready`}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: tokens.surface2, overflow: 'hidden', display: 'flex' }}>
        {total === 0
          ? null
          : order.map((s) => {
              const n = counts.get(s) ?? 0
              if (!n) return null
              return <div key={s} style={{ width: `${(n / total) * 100}%`, background: barColor(s), height: '100%' }} />
            })}
      </div>
    </div>
  )
}

/** A lightweight titled panel (used where a full Card header is overkill). */
export const Panel: React.FC<{ title?: string; actions?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  actions,
  children,
}) => (
  <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 12, background: tokens.surface, overflow: 'hidden' }}>
    {(title || actions) && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 16px',
          borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        {title ? <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: tokens.text }}>{title}</h3> : <span />}
        {actions}
      </div>
    )}
    <div style={{ padding: 16 }}>{children}</div>
  </div>
)
