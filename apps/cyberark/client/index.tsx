import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cyberark',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cyberark/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cyberark/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cyberark/connections', label: 'Connections', icon: 'link' },
  ],
}
