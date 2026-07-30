import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'fleet',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/fleet/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/fleet/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/fleet/connections', label: 'Connections', icon: 'link' },
  ],
}
