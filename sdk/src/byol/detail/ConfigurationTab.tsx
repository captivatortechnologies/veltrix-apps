import React from 'react'
import { EmptyState } from '../../ui'
import type { ByolConfigLink } from '../types'
import { tokens } from './shared'

export interface ConfigurationTabProps {
  /** App-supplied configuration links (the SDK stays app-agnostic). */
  links: ByolConfigLink[]
  /** Base path to config canvases, e.g. `/apps/splunk-enterprise/config`. */
  configBase?: string
}

/** Deep-links to the app's configuration surfaces — configure the running env. */
export const ConfigurationTab: React.FC<ConfigurationTabProps> = ({ links, configBase }) => {
  if (!links || links.length === 0) {
    return (
      <EmptyState
        title="No configuration surfaces linked"
        description="This app has not surfaced any configuration links for its BYOL environments."
      />
    )
  }

  const resolve = (link: ByolConfigLink): string | undefined => {
    if (configBase && link.configTypeId) return `${configBase}/${link.configTypeId}`
    return link.href
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>
        Once the environment is running, configure it as code. These open the app&rsquo;s configuration surfaces.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {links.map((link) => {
          const url = resolve(link)
          const inner = (
            <>
              <h4 style={{ margin: '0 0 4px', fontSize: 13, display: 'flex', justifyContent: 'space-between', color: tokens.text }}>
                {link.title}
                <span style={{ color: tokens.faint }} aria-hidden>
                  ↗
                </span>
              </h4>
              <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>{link.description}</p>
            </>
          )
          const cardStyle: React.CSSProperties = {
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            padding: 14,
            background: tokens.surface,
            textDecoration: 'none',
            color: 'inherit',
            display: 'block',
            cursor: url ? 'pointer' : 'default',
            opacity: url ? 1 : 0.7,
          }
          return url ? (
            <a key={link.key} href={url} style={cardStyle}>
              {inner}
            </a>
          ) : (
            <div key={link.key} style={cardStyle} title="This link is unavailable here">
              {inner}
            </div>
          )
        })}
      </div>
    </div>
  )
}
