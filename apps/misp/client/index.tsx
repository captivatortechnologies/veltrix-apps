import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'misp',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/misp/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/misp/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/misp/connections', label: 'Connections', icon: 'link' },
  ],
}
