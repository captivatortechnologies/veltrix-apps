import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cortex-xsoar',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cortex-xsoar/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cortex-xsoar/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cortex-xsoar/connections', label: 'Connections', icon: 'link' },
  ],
}
