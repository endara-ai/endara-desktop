import { describe, it, expect } from 'vitest';
import {
  RESERVED_PROFILE_PATHS,
  buildCreateProfilePayload,
  isCreateProfileFormValid,
  validateProfileName,
  validateProfilePath,
} from './create-profile-helpers';

// Engineering Spec §11 desktop test matrix — rows #1, #2, #3 cover the
// CreateProfileModal validation + submit pipeline. Component markup lives in
// `CreateProfileModal.svelte`; the validation + payload-building logic is
// pulled into `create-profile-helpers.ts` so it can be exercised without a
// DOM-rendering test setup (vitest runs in the Node environment here).

describe('validateProfilePath — matrix #1 (valid paths)', () => {
  it.each([
    ['work'],
    ['my-project'],
    ['side_project'],
    ['A1'],
    ['a'],
    ['9'],
    ['a-b_c-1'],
  ])('accepts %s', (path) => {
    expect(validateProfilePath(path)).toBeNull();
  });
});

describe('validateProfilePath — matrix #2 (invalid paths)', () => {
  it('rejects an empty string', () => {
    expect(validateProfilePath('')).toBe('Path is required');
  });

  it.each([
    ['-leading-dash'],
    ['_leading-underscore'],
    ['has space'],
    ['has/slash'],
    ['has.dot'],
    ['unicodé'],
    ['emoji🚀'],
  ])('rejects %s with a regex-violation message', (path) => {
    const msg = validateProfilePath(path);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/letters, numbers/);
  });

  it.each(RESERVED_PROFILE_PATHS)('rejects reserved path %s', (path) => {
    const msg = validateProfilePath(path);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/reserved/);
  });

  it('rejects reserved paths case-insensitively', () => {
    expect(validateProfilePath('SSE')).toMatch(/reserved/);
    expect(validateProfilePath('Tools')).toMatch(/reserved/);
    expect(validateProfilePath('OAUTH')).toMatch(/reserved/);
  });
});

describe('validateProfileName', () => {
  it('requires a non-empty name', () => {
    expect(validateProfileName('')).toBe('Name is required');
    expect(validateProfileName('   ')).toBe('Name is required');
  });

  it('accepts any non-empty freeform name', () => {
    expect(validateProfileName('Work')).toBeNull();
    expect(validateProfileName('Side Project 🚀')).toBeNull();
  });
});

describe('isCreateProfileFormValid', () => {
  it('is false when path is invalid even if name is valid', () => {
    expect(isCreateProfileFormValid('Work', 'has space')).toBe(false);
  });

  it('is false when name is empty even if path is valid', () => {
    expect(isCreateProfileFormValid('', 'work')).toBe(false);
  });

  it('is true when both fields pass validation', () => {
    expect(isCreateProfileFormValid('Work', 'work')).toBe(true);
  });
});

describe('buildCreateProfilePayload — matrix #3 (submit payload)', () => {
  it('builds the POST /api/profiles body with the modal inputs', () => {
    const payload = buildCreateProfilePayload({
      name: 'Work',
      path: 'work',
      jsExecution: true,
      toonOutput: true,
    });
    expect(payload).toEqual({
      name: 'Work',
      path: 'work',
      endpoints: [],
      js_execution: true,
      toon_output: true,
    });
  });

  it('trims surrounding whitespace from the name (path is regex-enforced)', () => {
    const payload = buildCreateProfilePayload({
      name: '  Side Project  ',
      path: 'side-project',
      jsExecution: false,
      toonOutput: true,
    });
    expect(payload.name).toBe('Side Project');
    expect(payload.path).toBe('side-project');
  });

  it('preserves the explicit toggle values without coercing to null', () => {
    const payload = buildCreateProfilePayload({
      name: 'Personal',
      path: 'personal',
      jsExecution: false,
      toonOutput: false,
    });
    expect(payload.js_execution).toBe(false);
    expect(payload.toon_output).toBe(false);
  });

  it('seeds an empty endpoints list (assignment happens after creation)', () => {
    const payload = buildCreateProfilePayload({
      name: 'Work',
      path: 'work',
      jsExecution: true,
      toonOutput: true,
    });
    expect(payload.endpoints).toEqual([]);
  });
});
