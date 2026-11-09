import type React from 'react'

export const MUTED: React.CSSProperties = { fontSize: 13, color: 'rgb(var(--color-content-secondary))' }
export const PAGE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, padding: 24 }
export const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
export const GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }
export const PANEL: React.CSSProperties = {
  border: '1px solid rgb(var(--color-border))',
  background: 'rgb(var(--color-surface-sunken))',
  borderRadius: 8,
  padding: 12,
}
export const MONO: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }
