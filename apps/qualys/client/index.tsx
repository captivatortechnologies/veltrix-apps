import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'qualys',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/qualys/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/qualys/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/qualys/connections', label: 'Connections', icon: 'link' },
  ],
}
