import type { IconType } from '@astryxdesign/core/Icon'
import {
  BellAlertIcon,
  ChartBarSquareIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  HashtagIcon,
  QueueListIcon,
  RocketLaunchIcon,
  ServerStackIcon,
  Squares2X2Icon,
  UsersIcon,
} from '@heroicons/react/24/outline'
import {
  BellAlertIcon as BellAlertSolid,
  ChartBarSquareIcon as ChartBarSquareSolid,
  Cog6ToothIcon as Cog6ToothSolid,
  CpuChipIcon as CpuChipSolid,
  HashtagIcon as HashtagSolid,
  QueueListIcon as QueueListSolid,
  RocketLaunchIcon as RocketLaunchSolid,
  ServerStackIcon as ServerStackSolid,
  Squares2X2Icon as Squares2X2Solid,
  UsersIcon as UsersSolid,
} from '@heroicons/react/24/solid'

export interface NavEntry {
  path: string
  label: string
  icon: IconType
  selectedIcon: IconType
}

export interface NavGroup {
  title: string
  entries: NavEntry[]
}

/** The console's destinations, in the order the side rail lists them. */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Community',
    entries: [
      { path: '/', label: 'Overview', icon: Squares2X2Icon, selectedIcon: Squares2X2Solid },
      { path: '/members', label: 'Members', icon: UsersIcon, selectedIcon: UsersSolid },
      { path: '/channels', label: 'Channels', icon: HashtagIcon, selectedIcon: HashtagSolid },
      { path: '/agents', label: 'Agents', icon: CpuChipIcon, selectedIcon: CpuChipSolid },
    ],
  },
  {
    title: 'Operations',
    entries: [
      { path: '/services', label: 'Services', icon: ServerStackIcon, selectedIcon: ServerStackSolid },
      { path: '/logs', label: 'Logs', icon: QueueListIcon, selectedIcon: QueueListSolid },
      { path: '/metrics', label: 'Metrics', icon: ChartBarSquareIcon, selectedIcon: ChartBarSquareSolid },
      { path: '/alerts', label: 'Alerts', icon: BellAlertIcon, selectedIcon: BellAlertSolid },
      { path: '/deployments', label: 'Deployments', icon: RocketLaunchIcon, selectedIcon: RocketLaunchSolid },
    ],
  },
]

export const SETTINGS_ENTRY: NavEntry = {
  path: '/settings',
  label: 'Settings',
  icon: Cog6ToothIcon,
  selectedIcon: Cog6ToothSolid,
}

export function isActive(entryPath: string, pathname: string) {
  if (entryPath === '/') return pathname === '/'
  return pathname === entryPath || pathname.startsWith(`${entryPath}/`)
}
