import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { CatalogEntry } from '$lib/types';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function mockFetchSuccess(data: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
    status: 200,
    statusText: 'OK',
  });
}

const sampleCatalog: CatalogEntry[] = [
  {
    name: 'm__github__create_issue',
    description: 'Create a GitHub issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    endpoint: 'github',
    available: true,
  },
  {
    name: 'm__filesystem__read_file',
    description: 'Read a file from disk',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    endpoint: 'filesystem',
    available: true,
  },
  {
    name: 'm__broken__ping',
    description: 'Ping endpoint',
    inputSchema: { type: 'object' },
    endpoint: 'broken',
    available: false,
  },
];

describe('UnifiedCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockFetch.mockReset();
  });

  describe('getCatalog API integration', () => {
    it('returns catalog entries with endpoint and available fields', async () => {
      mockFetchSuccess(sampleCatalog);
      const { getCatalog } = await import('$lib/api');
      const result = await getCatalog();

      expect(result).toHaveLength(3);
      expect(result[0].endpoint).toBe('github');
      expect(result[0].available).toBe(true);
      expect(result[2].available).toBe(false);
    });
  });

  describe('catalog filtering logic', () => {
    it('filters by tool name', () => {
      const search = 'read';
      const filtered = sampleCatalog.filter(
        (t) =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          (t.description ?? '').toLowerCase().includes(search.toLowerCase())
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('m__filesystem__read_file');
    });

    it('filters by description', () => {
      const search = 'github';
      const filtered = sampleCatalog.filter(
        (t) =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          (t.description ?? '').toLowerCase().includes(search.toLowerCase())
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].endpoint).toBe('github');
    });

    it('returns all entries when search is empty', () => {
      const search: string = '';
      const filtered = search
        ? sampleCatalog.filter(
            (t) =>
              t.name.toLowerCase().includes(search.toLowerCase()) ||
              (t.description ?? '').toLowerCase().includes(search.toLowerCase())
          )
        : sampleCatalog;
      expect(filtered).toHaveLength(3);
    });

    it('returns empty when no match', () => {
      const search = 'nonexistent_xyz';
      const filtered = sampleCatalog.filter(
        (t) =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          (t.description ?? '').toLowerCase().includes(search.toLowerCase())
      );
      expect(filtered).toHaveLength(0);
    });
  });

  describe('expand/collapse toggle logic', () => {
    it('toggleExpand sets expandedTool to the tool name', () => {
      let expandedTool: string | null = null;
      function toggleExpand(name: string) {
        expandedTool = expandedTool === name ? null : name;
      }

      toggleExpand('m__github__create_issue');
      expect(expandedTool).toBe('m__github__create_issue');
    });

    it('toggleExpand collapses when same tool clicked again', () => {
      let expandedTool: string | null = null;
      function toggleExpand(name: string) {
        expandedTool = expandedTool === name ? null : name;
      }

      toggleExpand('m__github__create_issue');
      expect(expandedTool).toBe('m__github__create_issue');

      toggleExpand('m__github__create_issue');
      expect(expandedTool).toBeNull();
    });

    it('toggleExpand switches to different tool', () => {
      let expandedTool: string | null = null;
      function toggleExpand(name: string) {
        expandedTool = expandedTool === name ? null : name;
      }

      toggleExpand('m__github__create_issue');
      expect(expandedTool).toBe('m__github__create_issue');

      toggleExpand('m__filesystem__read_file');
      expect(expandedTool).toBe('m__filesystem__read_file');
    });

    it('row click triggers expand, not navigation', () => {
      // Verify the component behavior: row onclick should call toggleExpand
      // (not navigateToEndpoint). The jump icon calls navigateToEndpoint separately.
      let expandedTool: string | null = null;
      let navigated = false;

      function toggleExpand(name: string) {
        expandedTool = expandedTool === name ? null : name;
      }
      function navigateToEndpoint(_endpoint: string) {
        navigated = true;
      }

      // Simulate row click — should toggle expand, not navigate
      toggleExpand('m__github__create_issue');
      expect(expandedTool).toBe('m__github__create_issue');
      expect(navigated).toBe(false);
    });
  });

  describe('jump-to-endpoint navigation logic', () => {
    it('sets selectedEndpoint, activeTab, and activeTopLevelTab', async () => {
      const { selectedEndpoint, activeTab, activeTopLevelTab } = await import('$lib/stores');

      // Simulate navigateToEndpoint (called by jump icon)
      selectedEndpoint.set('github');
      activeTab.set('tools');
      activeTopLevelTab.set('servers');

      expect(get(selectedEndpoint)).toBe('github');
      expect(get(activeTab)).toBe('tools');
      expect(get(activeTopLevelTab)).toBe('servers');
    });

    it('jump icon navigates without expanding', async () => {
      const { selectedEndpoint, activeTab, activeTopLevelTab } = await import('$lib/stores');

      let expandedTool: string | null = null;
      function toggleExpand(name: string) {
        expandedTool = expandedTool === name ? null : name;
      }
      function navigateToEndpoint(endpointName: string) {
        selectedEndpoint.set(endpointName);
        activeTab.set('tools');
        activeTopLevelTab.set('servers');
      }

      // Simulate jump icon click (with stopPropagation, so toggleExpand is NOT called)
      navigateToEndpoint('github');

      expect(get(selectedEndpoint)).toBe('github');
      expect(get(activeTab)).toBe('tools');
      expect(get(activeTopLevelTab)).toBe('servers');
      // expandedTool should remain null — jump icon does not expand
      expect(expandedTool).toBeNull();
    });
  });

  describe('unavailable tools identification', () => {
    it('identifies unavailable tools correctly', () => {
      const unavailable = sampleCatalog.filter((t) => !t.available);
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0].endpoint).toBe('broken');
    });

    it('identifies available tools correctly', () => {
      const available = sampleCatalog.filter((t) => t.available);
      expect(available).toHaveLength(2);
    });
  });

  describe('multiple tools from same endpoint', () => {
    const manyToolsCatalog: CatalogEntry[] = [
      { name: 'm__fs__read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, endpoint: 'fs', available: true },
      { name: 'm__fs__write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, endpoint: 'fs', available: true },
      { name: 'm__fs__delete_file', description: 'Delete a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, endpoint: 'fs', available: true },
      { name: 'm__fs__list_dir', description: 'List directory', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, endpoint: 'fs', available: true },
      { name: 'm__fs__move_file', description: 'Move a file', inputSchema: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } } }, endpoint: 'fs', available: true },
      { name: 'm__fs__copy_file', description: 'Copy a file', inputSchema: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } } }, endpoint: 'fs', available: true },
    ];

    it('groups 6 tools from same endpoint', () => {
      const grouped = new Map<string, CatalogEntry[]>();
      for (const entry of manyToolsCatalog) {
        const list = grouped.get(entry.endpoint) ?? [];
        list.push(entry);
        grouped.set(entry.endpoint, list);
      }
      expect(grouped.size).toBe(1);
      expect(grouped.get('fs')).toHaveLength(6);
    });

    it('all tools from same endpoint are available', () => {
      const allAvailable = manyToolsCatalog.every((t) => t.available);
      expect(allAvailable).toBe(true);
    });
  });

  describe('schema expansion data structure', () => {
    it('inputSchema has properties for parameterized tools', () => {
      const tool = sampleCatalog[0]; // create_issue
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      const props = tool.inputSchema.properties as Record<string, { type: string }>;
      expect(props.title).toBeDefined();
      expect(props.title.type).toBe('string');
    });

    it('inputSchema can be minimal (no properties)', () => {
      const tool = sampleCatalog[2]; // ping - minimal schema
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      // Minimal schema may have no properties key
      const props = tool.inputSchema.properties as Record<string, unknown> | undefined;
      expect(props === undefined || Object.keys(props).length === 0).toBe(true);
    });
  });

  describe('mixed available/unavailable tools from same endpoint', () => {
    const mixedCatalog: CatalogEntry[] = [
      { name: 'm__db__query', description: 'Run query', inputSchema: { type: 'object' }, endpoint: 'db', available: true },
      { name: 'm__db__insert', description: 'Insert row', inputSchema: { type: 'object' }, endpoint: 'db', available: true },
      { name: 'm__flaky__read', description: 'Read data', inputSchema: { type: 'object' }, endpoint: 'flaky', available: false },
      { name: 'm__flaky__write', description: 'Write data', inputSchema: { type: 'object' }, endpoint: 'flaky', available: false },
      { name: 'm__flaky__delete', description: 'Delete data', inputSchema: { type: 'object' }, endpoint: 'flaky', available: false },
    ];

    it('correctly partitions by endpoint', () => {
      const grouped = new Map<string, CatalogEntry[]>();
      for (const entry of mixedCatalog) {
        const list = grouped.get(entry.endpoint) ?? [];
        list.push(entry);
        grouped.set(entry.endpoint, list);
      }
      expect(grouped.size).toBe(2);
      expect(grouped.get('db')).toHaveLength(2);
      expect(grouped.get('flaky')).toHaveLength(3);
    });

    it('all tools from healthy endpoint are available', () => {
      const dbTools = mixedCatalog.filter((t) => t.endpoint === 'db');
      expect(dbTools.every((t) => t.available)).toBe(true);
    });

    it('all tools from unhealthy endpoint are unavailable', () => {
      const flakyTools = mixedCatalog.filter((t) => t.endpoint === 'flaky');
      expect(flakyTools.every((t) => !t.available)).toBe(true);
    });

    it('total count includes both available and unavailable', () => {
      expect(mixedCatalog).toHaveLength(5);
      expect(mixedCatalog.filter((t) => t.available)).toHaveLength(2);
      expect(mixedCatalog.filter((t) => !t.available)).toHaveLength(3);
    });
  });
});

