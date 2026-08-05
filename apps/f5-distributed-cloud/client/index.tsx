import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'f5-distributed-cloud',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/f5-distributed-cloud/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/f5-distributed-cloud/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/f5-distributed-cloud/connections', label: 'Connections', icon: 'link' },
  ],
}
