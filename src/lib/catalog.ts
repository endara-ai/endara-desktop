export interface CatalogEnvVar {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
  helpUrl?: string;
}

export interface CatalogServer {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'developer' | 'search' | 'productivity' | 'data';
  transport: 'stdio' | 'sse' | 'http';
  command: string;
  args: string[];
  envVars: CatalogEnvVar[];
  userArgs?: { label: string; placeholder: string }[];
}

export const CATALOG_SERVERS: CatalogServer[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage files on the local filesystem.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5C3 3.67 3.67 3 4.5 3h4.59a1.5 1.5 0 0 1 1.06.44l1.41 1.41a1.5 1.5 0 0 0 1.06.44H15.5c.83 0 1.5.67 1.5 1.5V15.5c0 .83-.67 1.5-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5V4.5Z"/></svg>',
    category: 'developer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envVars: [],
    userArgs: [{ label: 'Allowed directory', placeholder: '/Users/you/projects' }],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Interact with GitHub repositories, issues, pull requests, and more.',
    icon: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.5a8.5 8.5 0 0 0-2.69 16.56c.43.08.58-.18.58-.4v-1.54c-2.37.52-2.87-1.01-2.87-1.01-.39-.99-.95-1.25-.95-1.25-.78-.53.06-.52.06-.52.86.06 1.31.88 1.31.88.76 1.3 2 .93 2.49.71.08-.55.3-.93.54-1.14-1.89-.21-3.88-.94-3.88-4.2 0-.93.33-1.69.88-2.28-.09-.22-.38-1.08.08-2.25 0 0 .72-.23 2.35.87a8.18 8.18 0 0 1 4.28 0c1.63-1.1 2.35-.87 2.35-.87.46 1.17.17 2.03.08 2.25.55.59.88 1.35.88 2.28 0 3.27-1.99 3.99-3.89 4.2.31.26.58.78.58 1.58v2.34c0 .22.15.49.58.4A8.5 8.5 0 0 0 10 1.5Z"/></svg>',
    category: 'developer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envVars: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', required: true, secret: true, helpUrl: 'https://github.com/settings/tokens' },
    ],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web using the Brave Search API.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="5.5"/><path stroke-linecap="round" d="M13 13l4 4"/></svg>',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars: [
      { name: 'BRAVE_API_KEY', label: 'Brave API Key', required: true, secret: true, helpUrl: 'https://brave.com/search/api/' },
    ],
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Search places, get directions, and geocode addresses via Google Maps.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2C7.24 2 5 4.24 5 7c0 4.5 5 11 5 11s5-6.5 5-11c0-2.76-2.24-5-5-5Z"/><circle cx="10" cy="7" r="2"/></svg>',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    envVars: [
      { name: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps API Key', required: true, secret: true, helpUrl: 'https://console.cloud.google.com/apis/credentials' },
    ],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Automate browsers — take screenshots, scrape content, and interact with web pages.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="16" height="12" rx="1.5"/><path d="M2 6.5h16"/><circle cx="4.5" cy="4.75" r=".75" fill="currentColor" stroke="none"/><circle cx="6.75" cy="4.75" r=".75" fill="currentColor" stroke="none"/></svg>',
    category: 'developer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envVars: [],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent knowledge graph memory for maintaining context across sessions.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2a5 5 0 0 1 4.33 7.5A4.98 4.98 0 0 1 15 12.5c0 1.38-.56 2.63-1.46 3.54H6.46A4.98 4.98 0 0 1 5 12.5c0-1.1.36-2.13.97-2.96A5 5 0 0 1 10 2Z"/><path d="M7.5 16v1.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V16"/></svg>',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envVars: [],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Dynamic problem-solving through structured sequential thought processes.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4h8M6 8h10M6 12h7M6 16h9"/><circle cx="3" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="16" r="1" fill="currentColor" stroke="none"/></svg>',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envVars: [],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch and extract content from URLs and web pages.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7.5"/><ellipse cx="10" cy="10" rx="3" ry="7.5"/><path d="M3 10h14"/></svg>',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    envVars: [],
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    description: 'Query and interact with PostgreSQL databases.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="10" cy="5" rx="6" ry="2.5"/><path d="M4 5v10c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V5"/><path d="M4 10c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5"/></svg>',
    category: 'data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envVars: [
      { name: 'POSTGRESQL_CONNECTION_STRING', label: 'Connection String', required: true, secret: true },
    ],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage local SQLite databases.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="10" cy="5" rx="6" ry="2.5"/><path d="M4 5v10c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V5"/><path d="M4 10c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5"/></svg>',
    category: 'data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    envVars: [],
    userArgs: [{ label: 'Database path', placeholder: '/path/to/database.db' }],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read and send messages, manage channels in Slack workspaces.',
    icon: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M7.5 2a1.5 1.5 0 1 0 0 3H9V3.5A1.5 1.5 0 0 0 7.5 2ZM4 7.5A1.5 1.5 0 0 0 2 7.5 1.5 1.5 0 0 0 3.5 9H5V7.5ZM12.5 5a1.5 1.5 0 1 0 0-3A1.5 1.5 0 0 0 11 3.5V5h1.5ZM16 7.5A1.5 1.5 0 0 1 18 7.5 1.5 1.5 0 0 1 16.5 9H15V7.5ZM12.5 18a1.5 1.5 0 1 0 0-3H11v1.5a1.5 1.5 0 0 0 1.5 1.5ZM16 12.5a1.5 1.5 0 0 1 0 3h-1.5V14h1.5ZM7.5 15a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 1.5-1.5V15H7.5ZM4 12.5a1.5 1.5 0 0 0-2 0A1.5 1.5 0 0 0 3.5 14H5v-1.5Z"/></svg>',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envVars: [
      { name: 'SLACK_BOT_TOKEN', label: 'Bot Token', required: true, secret: true, helpUrl: 'https://api.slack.com/apps' },
      { name: 'SLACK_TEAM_ID', label: 'Team ID', required: true, secret: false, helpUrl: 'https://api.slack.com/apps' },
    ],
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Read, search, and analyze local Git repositories.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="6" cy="16" r="2"/><path d="M6 8v6M8 6h4"/></svg>',
    category: 'developer',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    envVars: [],
    userArgs: [{ label: 'Repository path', placeholder: '/path/to/repo' }],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Search and read files from Google Drive.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 3l6 0 4 7-3 5H3l3-5z"/><path d="M7 3l4 7H4"/><path d="M13 3l4 7"/></svg>',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    envVars: [
      { name: 'GDRIVE_CLIENT_ID', label: 'OAuth Client ID', required: true, secret: true, helpUrl: 'https://console.cloud.google.com/apis/credentials' },
      { name: 'GDRIVE_CLIENT_SECRET', label: 'OAuth Client Secret', required: true, secret: true, helpUrl: 'https://console.cloud.google.com/apis/credentials' },
    ],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Retrieve and analyze error reports and performance data from Sentry.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2l7 12H3L10 2Z"/><path d="M10 7v4"/><circle cx="10" cy="13" r=".5" fill="currentColor" stroke="none"/></svg>',
    category: 'developer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sentry'],
    envVars: [
      { name: 'SENTRY_AUTH_TOKEN', label: 'Auth Token', required: true, secret: true, helpUrl: 'https://sentry.io/settings/auth-tokens/' },
      { name: 'SENTRY_ORG', label: 'Organization Slug', required: true, secret: false },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Manage Cloudflare Workers, KV, R2, and D1 resources.',
    icon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 13a5 5 0 0 1 9.9-1A3.5 3.5 0 0 1 16.5 15H4a3 3 0 0 1-1-2Z"/></svg>',
    category: 'developer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@cloudflare/mcp-server-cloudflare'],
    envVars: [
      { name: 'CLOUDFLARE_API_TOKEN', label: 'API Token', required: true, secret: true, helpUrl: 'https://dash.cloudflare.com/profile/api-tokens' },
      { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', required: true, secret: false },
    ],
  },
];
