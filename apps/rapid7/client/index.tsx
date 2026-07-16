import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'rapid7',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/rapid7/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/rapid7/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/rapid7/connections', label: 'Connections', icon: 'link' },
  ],
}
