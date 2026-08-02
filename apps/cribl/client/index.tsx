import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cribl',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cribl/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cribl/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cribl/connections', label: 'Connections', icon: 'link' },
  ],
}
