import { vi } from 'vitest';

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/api/event
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Mock localStorage
const localStorageStore: Record<string, string> = {};
const localStorageMock: Storage = {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageStore[key];
  }),
  clear: vi.fn(() => {
    Object.keys(localStorageStore).forEach((key) => delete localStorageStore[key]);
  }),
  length: 0,
  key: vi.fn(() => null),
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// Mock document.documentElement
if (typeof document === 'undefined') {
  const classList = new Set<string>();
  const attributes = new Map<string, string>();
  const documentElement = {
    classList: {
      add: vi.fn((cls: string) => classList.add(cls)),
      remove: vi.fn((cls: string) => classList.delete(cls)),
      toggle: vi.fn((cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classList.has(cls)) classList.delete(cls);
          else classList.add(cls);
        } else if (force) {
          classList.add(cls);
        } else {
          classList.delete(cls);
        }
      }),
      contains: vi.fn((cls: string) => classList.has(cls)),
    },
    setAttribute: vi.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
    removeAttribute: vi.fn((name: string) => {
      attributes.delete(name);
    }),
    getAttribute: vi.fn((name: string) => attributes.get(name) ?? null),
    hasAttribute: vi.fn((name: string) => attributes.has(name)),
  };

  Object.defineProperty(globalThis, 'document', {
    value: { documentElement },
    writable: true,
  });
}

// Mock window.matchMedia
const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

Object.defineProperty(globalThis, 'matchMedia', { value: matchMediaMock, writable: true });

// Make sure window is defined with needed properties
if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    writable: true,
  });
}

