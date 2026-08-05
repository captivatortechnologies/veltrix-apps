import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'teleport',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/teleport/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/teleport/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/teleport/connections', label: 'Connections', icon: 'link' },
  ],
}
