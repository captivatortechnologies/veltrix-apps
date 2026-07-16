import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cloudflare',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cloudflare/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cloudflare/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cloudflare/connections', label: 'Connections', icon: 'link' },
  ],
}
