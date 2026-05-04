export interface OAuthCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'developer' | 'productivity' | 'search' | 'data';
  url: string;
  oauthServerUrl?: string;
  defaultScopes: string[];
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
];

