export interface OAuthScopeOption {
  /** Exact OAuth scope value sent on the wire. */
  scope: string;
  /** Short human-readable label shown next to the checkbox. */
  name: string;
  /** Longer description shown in the info tooltip alongside the exact scope. */
  description: string;
}

export interface OAuthCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'developer' | 'productivity' | 'search' | 'data';
  url: string;
  oauthServerUrl?: string;
  defaultScopes: string[];
  availableScopes?: OAuthScopeOption[];
  supportsDiscovery: boolean;
  supportsDcr: boolean;
  tokenEndpoint?: string;
  notes?: string;
}

export const oauthCatalog: OAuthCatalogEntry[] = [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issue tracking and project management',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 16.5l2.8-2.8a7 7 0 0 1-.8-3.2A7 7 0 0 1 12.5 3.5l.5.5a7 7 0 0 1-7 7 7 7 0 0 1-3.2-.8L3.5 16.5z" fill="currentColor" stroke="none"/></svg>',
    category: 'developer',
    url: 'https://mcp.linear.app/mcp',
    defaultScopes: ['read', 'write'],
    supportsDiscovery: true,
    supportsDcr: true,
    notes: 'Full issue, project, and team access',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Docs, wikis, and databases',
    icon: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4.5 2.5h9l2 2v13h-11V2.5zm2 4h7M6.5 9.5h7M6.5 12.5h5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    category: 'productivity',
    url: 'https://mcp.notion.com/mcp',
    defaultScopes: ['read', 'write'],
    supportsDiscovery: true,
    supportsDcr: true,
    notes: 'Requires Notion integration setup — you\'ll be prompted for client credentials',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Team messaging and channels',
    icon: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M7.5 2a1.5 1.5 0 1 0 0 3H9V3.5A1.5 1.5 0 0 0 7.5 2ZM4 7.5A1.5 1.5 0 0 0 2 7.5 1.5 1.5 0 0 0 3.5 9H5V7.5ZM12.5 5a1.5 1.5 0 1 0 0-3A1.5 1.5 0 0 0 11 3.5V5h1.5ZM16 7.5A1.5 1.5 0 0 1 18 7.5 1.5 1.5 0 0 1 16.5 9H15V7.5ZM12.5 18a1.5 1.5 0 1 0 0-3H11v1.5a1.5 1.5 0 0 0 1.5 1.5ZM16 12.5a1.5 1.5 0 0 1 0 3h-1.5V14h1.5ZM7.5 15a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 1.5-1.5V15H7.5ZM4 12.5a1.5 1.5 0 0 0-2 0A1.5 1.5 0 0 0 3.5 14H5v-1.5Z"/></svg>',
    category: 'productivity',
    url: 'https://mcp.slack.com/mcp',
    defaultScopes: ['channels:read', 'chat:write', 'users:read'],
    supportsDiscovery: true,
    supportsDcr: false,
    notes: 'Requires Slack app registration — you\'ll be prompted for client credentials',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Code hosting and collaboration',
    icon: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.5a8.5 8.5 0 0 0-2.69 16.56c.43.08.58-.18.58-.4v-1.54c-2.37.52-2.87-1.01-2.87-1.01-.39-.99-.95-1.25-.95-1.25-.78-.53.06-.52.06-.52.86.06 1.31.88 1.31.88.76 1.3 2 .93 2.49.71.08-.55.3-.93.54-1.14-1.89-.21-3.88-.94-3.88-4.2 0-.93.33-1.69.88-2.28-.09-.22-.38-1.08.08-2.25 0 0 .72-.23 2.35.87a8.18 8.18 0 0 1 4.28 0c1.63-1.1 2.35-.87 2.35-.87.46 1.17.17 2.03.08 2.25.55.59.88 1.35.88 2.28 0 3.27-1.99 3.99-3.89 4.2.31.26.58.78.58 1.58v2.34c0 .22.15.49.58.4A8.5 8.5 0 0 0 10 1.5Z"/></svg>',
    category: 'developer',
    url: 'https://api.githubcopilot.com/mcp/',
    oauthServerUrl: 'https://github.com/login/oauth',
    defaultScopes: ['repo', 'read:user'],
    supportsDiscovery: false,
    supportsDcr: false,
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    notes: 'Repository, issue, and PR access — requires GitHub OAuth app registration',
  },
  {
    id: 'todoist',
    name: 'Todoist',
    description: 'Task management and to-do lists',
    icon: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 5.5l1.2-.7L10 8.5l5.8-3.7L17 5.5l-7 4.5-7-4.5zm0 4l1.2-.7L10 12.5l5.8-3.7L17 9.5l-7 4.5-7-4.5zm0 4l1.2-.7L10 16.5l5.8-3.7L17 13.5l-7 4.5-7-4.5z"/></svg>',
    category: 'productivity',
    url: 'https://ai.todoist.net/mcp',
    defaultScopes: ['data:read_write'],
    supportsDiscovery: true,
    supportsDcr: true,
    notes: 'Task and project management',
  },
  {
    id: 'craft',
    name: 'Craft',
    description: 'Docs, notes, and knowledge base',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 4.5H7a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h7M14 4.5a3 3 0 0 1 0 6H7M14 4.5v6"/></svg>',
    category: 'productivity',
    url: 'https://mcp.craft.do/my/mcp',
    defaultScopes: ['read', 'write'],
    supportsDiscovery: true,
    supportsDcr: true,
    notes: 'Docs and notes from your Craft workspace',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read mail and manage drafts',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5.5h14v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9zm0 0l7 5 7-5"/></svg>',
    category: 'productivity',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    defaultScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    availableScopes: [
      {
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        name: 'Read mail',
        description: 'Read all messages and threads in your mailbox.',
      },
      {
        scope: 'https://www.googleapis.com/auth/gmail.compose',
        name: 'Compose drafts',
        description:
          'Create, read, update, and send drafts (does not include sending sent mail beyond drafts).',
      },
    ],
    supportsDiscovery: true,
    supportsDcr: false,
    notes: 'Requires a Google Cloud OAuth client — Client ID and Secret needed',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Calendars, events, and free/busy',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4.5" width="14" height="12" rx="1.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/></svg>',
    category: 'productivity',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    defaultScopes: [
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ],
    availableScopes: [
      {
        scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        name: 'List calendars',
        description: 'View the list of calendars on your account.',
      },
      {
        scope: 'https://www.googleapis.com/auth/calendar.events.freebusy',
        name: 'Free/busy',
        description: 'View free/busy information for events on your calendars.',
      },
      {
        scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
        name: 'Read events',
        description: 'View events on your calendars.',
      },
    ],
    supportsDiscovery: true,
    supportsDcr: false,
    notes: 'Requires a Google Cloud OAuth client — Client ID and Secret needed',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Files and folders in your Drive',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M7.5 3h5l5 8.5-2.5 4.5H5L2.5 11.5 7.5 3zM7.5 3l5 8.5h5M5 16l2.5-4.5h10"/></svg>',
    category: 'productivity',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    defaultScopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    availableScopes: [
      {
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        name: 'Read files',
        description: 'View metadata and content of files in your Drive.',
      },
      {
        scope: 'https://www.googleapis.com/auth/drive.file',
        name: 'Per-file access',
        description: 'Per-file access to files created or opened with this app.',
      },
    ],
    supportsDiscovery: true,
    supportsDcr: false,
    notes: 'Requires a Google Cloud OAuth client — Client ID and Secret needed',
  },
];

