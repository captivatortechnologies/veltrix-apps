import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'twingate',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/twingate/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/twingate/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/twingate/connections', label: 'Connections', icon: 'link' },
  ],
}
