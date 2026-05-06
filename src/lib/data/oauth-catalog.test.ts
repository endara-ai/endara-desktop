import { describe, it, expect } from 'vitest';
import { oauthCatalog } from './oauth-catalog';

describe('oauthCatalog', () => {
  it('should have exactly 9 entries', () => {
    expect(oauthCatalog).toHaveLength(9);
  });

  it('should include the Gmail entry with curated scopes', () => {
    const gmail = oauthCatalog.find((entry) => entry.id === 'gmail');
    expect(gmail).toBeDefined();
    expect(gmail!.url).toBe('https://gmailmcp.googleapis.com/mcp/v1');
    expect(gmail!.supportsDcr).toBe(false);
    expect(gmail!.defaultScopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
    expect(gmail!.availableScopes).toBeDefined();
    expect(gmail!.availableScopes!.length).toBeGreaterThan(0);
    const availableScopeValues = gmail!.availableScopes!.map((s) => s.scope);
    expect(availableScopeValues).toHaveLength(gmail!.defaultScopes.length);
    expect(new Set(availableScopeValues)).toEqual(new Set(gmail!.defaultScopes));
  });

  it('should include the Google Calendar entry with curated scopes', () => {
    const calendar = oauthCatalog.find((entry) => entry.id === 'google-calendar');
    expect(calendar).toBeDefined();
    expect(calendar!.url).toBe('https://calendarmcp.googleapis.com/mcp/v1');
    expect(calendar!.supportsDcr).toBe(false);
    expect(calendar!.defaultScopes).toEqual([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ]);
    expect(calendar!.availableScopes).toBeDefined();
    expect(calendar!.availableScopes!.length).toBeGreaterThan(0);
    const availableScopeValues = calendar!.availableScopes!.map((s) => s.scope);
    expect(availableScopeValues).toHaveLength(calendar!.defaultScopes.length);
    expect(new Set(availableScopeValues)).toEqual(new Set(calendar!.defaultScopes));
  });

  it('should include the Google Drive entry with curated scopes', () => {
    const drive = oauthCatalog.find((entry) => entry.id === 'google-drive');
    expect(drive).toBeDefined();
    expect(drive!.url).toBe('https://drivemcp.googleapis.com/mcp/v1');
    expect(drive!.supportsDcr).toBe(false);
    expect(drive!.defaultScopes).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ]);
    expect(drive!.availableScopes).toBeDefined();
    expect(drive!.availableScopes!.length).toBeGreaterThan(0);
    const availableScopeValues = drive!.availableScopes!.map((s) => s.scope);
    expect(availableScopeValues).toHaveLength(drive!.defaultScopes.length);
    expect(new Set(availableScopeValues)).toEqual(new Set(drive!.defaultScopes));
  });

  it('should have well-formed availableScopes entries everywhere they are defined', () => {
    for (const entry of oauthCatalog) {
      if (!entry.availableScopes) continue;
      for (const option of entry.availableScopes) {
        expect(option.name.length).toBeGreaterThan(0);
        expect(option.description.length).toBeGreaterThan(0);
        expect(option.scope.startsWith('https://')).toBe(true);
        expect(() => new URL(option.scope)).not.toThrow();
      }
    }
  });

  it('should have the correct GitHub URL', () => {
    const github = oauthCatalog.find((entry) => entry.id === 'github');
    expect(github).toBeDefined();
    expect(github!.url).toBe('https://api.githubcopilot.com/mcp/');
  });

  it('should have the correct Notion URL', () => {
    const notion = oauthCatalog.find((entry) => entry.id === 'notion');
    expect(notion).toBeDefined();
    expect(notion!.url).toBe('https://mcp.notion.com/mcp');
    expect(notion!.supportsDiscovery).toBe(true);
    expect(notion!.supportsDcr).toBe(true);
  });

  it('should have the correct Slack URL', () => {
    const slack = oauthCatalog.find((entry) => entry.id === 'slack');
    expect(slack).toBeDefined();
    expect(slack!.url).toBe('https://mcp.slack.com/mcp');
    expect(slack!.supportsDiscovery).toBe(true);
    expect(slack!.supportsDcr).toBe(false);
  });

  it('should have the correct Linear URL', () => {
    const linear = oauthCatalog.find((entry) => entry.id === 'linear');
    expect(linear).toBeDefined();
    expect(linear!.url).toBe('https://mcp.linear.app/mcp');
    expect(linear!.supportsDiscovery).toBe(true);
    expect(linear!.supportsDcr).toBe(true);
  });

  it('should have the correct Todoist entry', () => {
    const todoist = oauthCatalog.find((entry) => entry.id === 'todoist');
    expect(todoist).toBeDefined();
    expect(todoist!.url).toBe('https://ai.todoist.net/mcp');
    expect(todoist!.supportsDcr).toBe(true);
  });

  it('should have the correct Craft entry', () => {
    const craft = oauthCatalog.find((entry) => entry.id === 'craft');
    expect(craft).toBeDefined();
    expect(craft!.url).toBe('https://mcp.craft.do/my/mcp');
    expect(craft!.supportsDiscovery).toBe(true);
    expect(craft!.supportsDcr).toBe(true);
  });
});

