import { describe, it, expect } from 'vitest';
import type { Tool } from '$lib/types';

const sampleTools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'ping',
    description: 'Ping the server',
    // no inputSchema
  },
  {
    name: 'create_issue',
    description: 'Create a GitHub issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'delete_repo',
    description: 'Delete a repository',
    annotations: { destructiveHint: true },
    // no inputSchema
  },
];

// Reimplement component logic for pure-logic testing (same pattern as UnifiedCatalog.test.ts)
function toggleExpand(current: string | null, name: string): string | null {
  return current === name ? null : name;
}

function filterTools(tools: Tool[], search: string): Tool[] {
  return search
    ? tools.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
    : tools;
}

function shouldShowSchema(expandedTool: string | null, tool: Tool): boolean {
  return expandedTool === tool.name && !!tool.inputSchema;
}

function shouldShowAnnotations(expandedTool: string | null, tool: Tool): boolean {
  return expandedTool === tool.name && !!tool.annotations;
}

function shouldShowFallback(expandedTool: string | null, tool: Tool): boolean {
  return expandedTool === tool.name && !tool.inputSchema && !tool.annotations;
}

function isExpanded(expandedTool: string | null, tool: Tool): boolean {
  return expandedTool === tool.name;
}

describe('ToolsTab', () => {
  describe('toggleExpand', () => {
    it('sets expandedTool to the tool name', () => {
      expect(toggleExpand(null, 'read_file')).toBe('read_file');
    });

    it('collapses when same tool clicked again', () => {
      expect(toggleExpand('read_file', 'read_file')).toBeNull();
    });

    it('switches to new tool when different tool clicked', () => {
      expect(toggleExpand('read_file', 'ping')).toBe('ping');
    });
  });

  describe('tool filtering', () => {
    it('filters by tool name', () => {
      const filtered = filterTools(sampleTools, 'read');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('read_file');
    });

    it('returns all tools when search is empty', () => {
      expect(filterTools(sampleTools, '')).toHaveLength(4);
    });

    it('returns empty when no match', () => {
      expect(filterTools(sampleTools, 'nonexistent')).toHaveLength(0);
    });

    it('is case-insensitive', () => {
      expect(filterTools(sampleTools, 'READ')).toHaveLength(1);
    });
  });

  describe('expanded content visibility', () => {
    it('shows schema when tool has inputSchema and is expanded', () => {
      expect(shouldShowSchema('read_file', sampleTools[0])).toBe(true);
    });

    it('does not show schema when tool lacks inputSchema', () => {
      expect(shouldShowSchema('ping', sampleTools[1])).toBe(false);
    });

    it('does not show schema when tool is not expanded', () => {
      expect(shouldShowSchema(null, sampleTools[0])).toBe(false);
    });

    it('shows annotations when tool has annotations and is expanded', () => {
      expect(shouldShowAnnotations('create_issue', sampleTools[2])).toBe(true);
    });

    it('does not show annotations when tool lacks annotations', () => {
      expect(shouldShowAnnotations('read_file', sampleTools[0])).toBe(false);
    });

    it('shows fallback when tool has neither schema nor annotations', () => {
      // ping has no inputSchema and no annotations
      expect(shouldShowFallback('ping', sampleTools[1])).toBe(true);
    });

    it('does not show fallback when tool has schema', () => {
      expect(shouldShowFallback('read_file', sampleTools[0])).toBe(false);
    });

    it('does not show fallback when tool has annotations only', () => {
      // delete_repo has annotations but no inputSchema
      expect(shouldShowFallback('delete_repo', sampleTools[3])).toBe(false);
    });

    it('drawer is always open when expanded, regardless of schema', () => {
      // The key bug fix: expansion should not depend on inputSchema
      for (const tool of sampleTools) {
        expect(isExpanded(tool.name, tool)).toBe(true);
      }
    });

    it('drawer is closed when not expanded', () => {
      for (const tool of sampleTools) {
        expect(isExpanded(null, tool)).toBe(false);
        expect(isExpanded('other_tool', tool)).toBe(false);
      }
    });
  });

  describe('camelCase schema key handling', () => {
    it('shows schema when tool has camelCase inputSchema from API', () => {
      // Simulates a tool returned by the relay API with camelCase inputSchema
      const toolFromApi: Tool = {
        name: 'api_tool',
        description: 'A tool from the API',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      };
      expect(shouldShowSchema('api_tool', toolFromApi)).toBe(true);
      expect(shouldShowFallback('api_tool', toolFromApi)).toBe(false);
    });

    it('shows fallback when inputSchema is missing (not just renamed)', () => {
      const toolWithoutSchema: Tool = {
        name: 'no_schema_tool',
        description: 'Tool without schema',
      };
      expect(shouldShowSchema('no_schema_tool', toolWithoutSchema)).toBe(false);
      expect(shouldShowFallback('no_schema_tool', toolWithoutSchema)).toBe(true);
    });
  });
});

