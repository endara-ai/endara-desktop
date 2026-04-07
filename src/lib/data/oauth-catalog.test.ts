import { describe, it, expect } from 'vitest';
import { oauthCatalog } from './oauth-catalog';

describe('oauthCatalog', () => {
  it('should have exactly 5 entries', () => {
    expect(oauthCatalog).toHaveLength(5);
  });

  it('should not include Google Drive', () => {
    const googleDrive = oauthCatalog.find((entry) => entry.id === 'google-drive');
    expect(googleDrive).toBeUndefined();
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
    expect(linear!.url).toBe('https://mcp.linear.app/sse');
    expect(linear!.supportsDiscovery).toBe(true);
    expect(linear!.supportsDcr).toBe(true);
  });

  it('should have the correct Todoist entry', () => {
    const todoist = oauthCatalog.find((entry) => entry.id === 'todoist');
    expect(todoist).toBeDefined();
    expect(todoist!.url).toBe('https://ai.todoist.net/mcp');
    expect(todoist!.supportsDcr).toBe(true);
  });
});

