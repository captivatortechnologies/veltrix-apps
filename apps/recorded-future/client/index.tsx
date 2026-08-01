import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'recorded-future',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/recorded-future/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/recorded-future/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/recorded-future/connections', label: 'Connections', icon: 'link' },
  ],
}
