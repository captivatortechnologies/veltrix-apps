import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'sentinelone',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/sentinelone/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/sentinelone/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/sentinelone/connections', label: 'Connections', icon: 'link' },
  ],
}
