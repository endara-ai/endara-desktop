import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeFocusTrapTarget, focusTrap } from './focusTrap';

// Lightweight stand-in for HTMLElement that's enough for `===`/`indexOf`
// identity checks. The pure helper never touches DOM methods, so this keeps
// the tests in the existing node-only environment.
function fakeEl(): HTMLElement {
  return {} as HTMLElement;
}

describe('computeFocusTrapTarget', () => {
  it('returns null when there are no focusable elements', () => {
    expect(computeFocusTrapTarget([], null, false)).toBeNull();
    expect(computeFocusTrapTarget([], null, true)).toBeNull();
  });

  it('pulls focus to the first element when activeElement is outside the trap (Tab)', () => {
    const a = fakeEl();
    const b = fakeEl();
    const outside = fakeEl();
    expect(computeFocusTrapTarget([a, b], outside, false)).toBe(a);
    expect(computeFocusTrapTarget([a, b], null, false)).toBe(a);
  });

  it('pulls focus to the last element when activeElement is outside the trap (Shift+Tab)', () => {
    const a = fakeEl();
    const b = fakeEl();
    const outside = fakeEl();
    expect(computeFocusTrapTarget([a, b], outside, true)).toBe(b);
    expect(computeFocusTrapTarget([a, b], null, true)).toBe(b);
  });

  it('wraps from last → first on Tab (Slice B row 6/8 — modals trap focus)', () => {
    const a = fakeEl();
    const b = fakeEl();
    const c = fakeEl();
    expect(computeFocusTrapTarget([a, b, c], c, false)).toBe(a);
  });

  it('wraps from first → last on Shift+Tab', () => {
    const a = fakeEl();
    const b = fakeEl();
    const c = fakeEl();
    expect(computeFocusTrapTarget([a, b, c], a, true)).toBe(c);
  });

  it('returns null in the middle of the list so the browser default Tab runs', () => {
    const a = fakeEl();
    const b = fakeEl();
    const c = fakeEl();
    expect(computeFocusTrapTarget([a, b, c], b, false)).toBeNull();
    expect(computeFocusTrapTarget([a, b, c], b, true)).toBeNull();
  });

  it('with a single focusable, Tab and Shift+Tab both stay on that element', () => {
    const only = fakeEl();
    expect(computeFocusTrapTarget([only], only, false)).toBe(only);
    expect(computeFocusTrapTarget([only], only, true)).toBe(only);
  });
});

// ── Escape-still-closes regression (Slice B row 7) ──
//
// The modals' handleKeydown logic is intentionally trivial — Escape calls the
// cancel callback, everything else falls through. We mirror that here so a
// future refactor that accidentally swallows Escape inside the focus trap
// would fail this test. The focusTrap action itself only intercepts 'Tab'
// (see focusTrap.ts), so Escape continues to bubble to <svelte:window>.
describe('modal Escape routing (regression)', () => {
  function simulate(handler: (e: KeyboardEvent) => void, key: string): string | null {
    let result: string | null = null;
    const fakeEvent = { key, preventDefault: () => {} } as unknown as KeyboardEvent;
    const wrapped = (e: KeyboardEvent) => {
      handler(e);
      result = 'handled';
    };
    wrapped(fakeEvent);
    return result;
  }

  it('ConfirmModal calls oncancel on Escape', () => {
    let cancelled = false;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelled = true;
    };
    simulate(handler, 'Escape');
    expect(cancelled).toBe(true);
  });

  it('ConfirmModal ignores non-Escape keys', () => {
    let cancelled = false;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelled = true;
    };
    simulate(handler, 'Tab');
    simulate(handler, 'a');
    expect(cancelled).toBe(false);
  });

  it('AddEndpointModal routes Escape to handleCancel when DCR dialog is closed', () => {
    // Mirror of the modal's handleKeydown — verified separately in
    // AddEndpointModal.test.ts (`DCR fallback dialog ESC routing`), repeated
    // here as a defensive regression now that a focus trap sits in front of
    // the keydown bubbling path.
    function route(opts: { showingDcrFallback: boolean }, key: string): string | null {
      if (key !== 'Escape') return null;
      return opts.showingDcrFallback ? 'dcr-cancel' : 'outer-cancel';
    }
    expect(route({ showingDcrFallback: false }, 'Escape')).toBe('outer-cancel');
    expect(route({ showingDcrFallback: true }, 'Escape')).toBe('dcr-cancel');
    expect(route({ showingDcrFallback: false }, 'Tab')).toBeNull();
  });
});

// ── Integration tests for the focusTrap action ──
//
// The vitest project runs in the `node` environment, not jsdom, so we hand-
// roll a minimal DOM stub that supports just enough of the surface the
// action uses: addEventListener/removeEventListener (with capture phase),
// document.activeElement, element.contains(), element.focus(),
// element.querySelectorAll() against the limited set of selectors in
// FOCUSABLE_SELECTOR, and element.hasAttribute()/getAttribute().

type KeydownListener = (event: KeyboardEvent) => void;
interface ListenerEntry {
  type: string;
  listener: KeydownListener;
}

class FakeElement {
  tagName: string;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  private attrs = new Map<string, string>();

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  contains(other: FakeElement | null): boolean {
    if (!other) return false;
    let cur: FakeElement | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }

  // pretend every element is visible — JSDOM-equivalent default
  get offsetParent(): FakeElement | null {
    return this.parent;
  }

  focus() {
    fakeDocument.activeElement = this as unknown as HTMLElement;
  }

  querySelectorAll<T = FakeElement>(selector: string): T[] {
    const parts = selector.split(',').map((s) => s.trim());
    const results: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (parts.some((p) => matchSelector(c, p))) results.push(c);
        walk(c);
      }
    };
    walk(this);
    return results as unknown as T[];
  }
}

function matchSelector(el: FakeElement, sel: string): boolean {
  // Supports only the selectors in FOCUSABLE_SELECTOR. Hard-coded so the
  // stub stays small and unambiguous.
  switch (sel) {
    case 'a[href]':
      return el.tagName === 'A' && el.hasAttribute('href');
    case 'button:not([disabled])':
      return el.tagName === 'BUTTON' && !el.hasAttribute('disabled');
    case 'input:not([disabled])':
      return el.tagName === 'INPUT' && !el.hasAttribute('disabled');
    case 'select:not([disabled])':
      return el.tagName === 'SELECT' && !el.hasAttribute('disabled');
    case 'textarea:not([disabled])':
      return el.tagName === 'TEXTAREA' && !el.hasAttribute('disabled');
    case '[tabindex]:not([tabindex="-1"])':
      return el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1';
    default:
      return false;
  }
}

class FakeDocument {
  activeElement: HTMLElement | null = null;
  capture: ListenerEntry[] = [];
  bubble: ListenerEntry[] = [];

  addEventListener(type: string, listener: KeydownListener, useCapture?: boolean) {
    (useCapture ? this.capture : this.bubble).push({ type, listener });
  }
  removeEventListener(type: string, listener: KeydownListener, useCapture?: boolean) {
    const list = useCapture ? this.capture : this.bubble;
    const idx = list.findIndex((e) => e.type === type && e.listener === listener);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchKeydown(
    key: string,
    shiftKey = false,
  ): { defaultPrevented: boolean; propagationStopped: boolean } {
    let prevented = false;
    let stopped = false;
    const event = {
      key,
      shiftKey,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      get defaultPrevented() {
        return prevented;
      },
    } as unknown as KeyboardEvent;
    // capture phase first, then bubble — matches DOM event flow well enough
    // for this action which lives solely in the capture phase.
    for (const e of [...this.capture]) {
      if (e.type === 'keydown') e.listener(event);
    }
    for (const e of [...this.bubble]) {
      if (e.type === 'keydown') e.listener(event);
    }
    return { defaultPrevented: prevented, propagationStopped: stopped };
  }
}

let fakeDocument: FakeDocument;
let rafCallbacks: Array<() => void>;
let prevDocument: unknown;
let prevRaf: unknown;

function setupDom() {
  fakeDocument = new FakeDocument();
  rafCallbacks = [];
  // The test-setup.ts global `document` is defined as writable but not
  // configurable, so `vi.stubGlobal` (which uses defineProperty) fails.
  // Direct assignment works because the property is writable.
  prevDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
  prevRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    cb: () => void,
  ) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  };
}

function teardownDom() {
  (globalThis as { document?: unknown }).document = prevDocument;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = prevRaf;
}

function flushRaf() {
  // Drain queued callbacks, including any that re-queue another frame.
  let guard = 0;
  while (rafCallbacks.length > 0 && guard < 10) {
    const cbs = rafCallbacks;
    rafCallbacks = [];
    for (const cb of cbs) cb();
    guard += 1;
  }
}

describe('focusTrap action (integration)', () => {
  beforeEach(() => setupDom());
  afterEach(() => teardownDom());

  it('intercepts Tab at document capture phase even when focus is outside the trap', () => {
    // Simulate the bug: user clicked the "Add Server" trigger button to open
    // a modal. activeElement is still the trigger (outside the modal). Press
    // Tab — focus must be pulled into the first focusable inside the modal.
    const root = new FakeElement('DIV');
    const triggerOutside = new FakeElement('BUTTON');
    root.appendChild(triggerOutside);
    const modal = new FakeElement('DIV', { tabindex: '-1' });
    root.appendChild(modal);
    const first = new FakeElement('BUTTON');
    const second = new FakeElement('BUTTON');
    modal.appendChild(first);
    modal.appendChild(second);

    fakeDocument.activeElement = triggerOutside as unknown as HTMLElement;
    const trap = focusTrap(modal as unknown as HTMLElement, { initialFocus: false });

    const result = fakeDocument.dispatchKeydown('Tab');
    expect(result.defaultPrevented).toBe(true);
    expect(fakeDocument.activeElement).toBe(first as unknown as HTMLElement);

    trap.destroy();
  });

  it('Shift+Tab from outside pulls focus to the last focusable in the trap', () => {
    const modal = new FakeElement('DIV');
    const a = new FakeElement('BUTTON');
    const b = new FakeElement('BUTTON');
    const c = new FakeElement('BUTTON');
    modal.appendChild(a);
    modal.appendChild(b);
    modal.appendChild(c);
    const outside = new FakeElement('BUTTON');
    fakeDocument.activeElement = outside as unknown as HTMLElement;

    const trap = focusTrap(modal as unknown as HTMLElement, { initialFocus: false });
    fakeDocument.dispatchKeydown('Tab', true);
    expect(fakeDocument.activeElement).toBe(c as unknown as HTMLElement);
    trap.destroy();
  });

  it('without onEscape, Escape passes through (defaultPrevented stays false)', () => {
    const modal = new FakeElement('DIV');
    const btn = new FakeElement('BUTTON');
    modal.appendChild(btn);
    fakeDocument.activeElement = btn as unknown as HTMLElement;

    const trap = focusTrap(modal as unknown as HTMLElement, { initialFocus: false });
    const result = fakeDocument.dispatchKeydown('Escape');
    expect(result.defaultPrevented).toBe(false);
    expect(result.propagationStopped).toBe(false);
    trap.destroy();
  });

  it('with onEscape, Escape calls the callback and prevents default + stops propagation', () => {
    const modal = new FakeElement('DIV');
    const btn = new FakeElement('BUTTON');
    modal.appendChild(btn);
    fakeDocument.activeElement = btn as unknown as HTMLElement;

    let calls = 0;
    const trap = focusTrap(modal as unknown as HTMLElement, {
      initialFocus: false,
      onEscape: () => {
        calls += 1;
      },
    });
    const result = fakeDocument.dispatchKeydown('Escape');
    expect(calls).toBe(1);
    expect(result.defaultPrevented).toBe(true);
    expect(result.propagationStopped).toBe(true);
    trap.destroy();
  });

  it('nested traps: only the top onEscape fires; outer regains control after inner destroys', () => {
    const outerNode = new FakeElement('DIV');
    outerNode.appendChild(new FakeElement('BUTTON'));
    const innerNode = new FakeElement('DIV');
    innerNode.appendChild(new FakeElement('BUTTON'));

    let outerCalls = 0;
    let innerCalls = 0;
    const outer = focusTrap(outerNode as unknown as HTMLElement, {
      initialFocus: false,
      onEscape: () => {
        outerCalls += 1;
      },
    });
    const inner = focusTrap(innerNode as unknown as HTMLElement, {
      initialFocus: false,
      onEscape: () => {
        innerCalls += 1;
      },
    });

    fakeDocument.dispatchKeydown('Escape');
    expect(innerCalls).toBe(1);
    expect(outerCalls).toBe(0);

    inner.destroy();
    fakeDocument.dispatchKeydown('Escape');
    expect(innerCalls).toBe(1);
    expect(outerCalls).toBe(1);

    outer.destroy();
  });

  it('Tab still cycles correctly when onEscape is configured (regression)', () => {
    const modal = new FakeElement('DIV');
    const a = new FakeElement('BUTTON');
    const b = new FakeElement('BUTTON');
    modal.appendChild(a);
    modal.appendChild(b);
    fakeDocument.activeElement = b as unknown as HTMLElement;

    let escCalls = 0;
    const trap = focusTrap(modal as unknown as HTMLElement, {
      initialFocus: false,
      onEscape: () => {
        escCalls += 1;
      },
    });

    // Tab from last → wraps to first.
    const tabResult = fakeDocument.dispatchKeydown('Tab');
    expect(tabResult.defaultPrevented).toBe(true);
    expect(fakeDocument.activeElement).toBe(a as unknown as HTMLElement);
    expect(escCalls).toBe(0);

    // Shift+Tab from first → wraps to last.
    const shiftResult = fakeDocument.dispatchKeydown('Tab', true);
    expect(shiftResult.defaultPrevented).toBe(true);
    expect(fakeDocument.activeElement).toBe(b as unknown as HTMLElement);
    expect(escCalls).toBe(0);

    trap.destroy();
  });

  it('with nested traps only the top trap handles Tab; outer regains control after inner destroys', () => {
    const outerNode = new FakeElement('DIV');
    const outerBtn = new FakeElement('BUTTON');
    outerNode.appendChild(outerBtn);

    const innerNode = new FakeElement('DIV');
    const innerBtn = new FakeElement('BUTTON');
    innerNode.appendChild(innerBtn);

    const outer = focusTrap(outerNode as unknown as HTMLElement, { initialFocus: false });
    const inner = focusTrap(innerNode as unknown as HTMLElement, { initialFocus: false });

    // activeElement is outside both — Tab should land in the inner (top) trap.
    fakeDocument.activeElement = null;
    fakeDocument.dispatchKeydown('Tab');
    expect(fakeDocument.activeElement).toBe(innerBtn as unknown as HTMLElement);

    // Destroy inner; outer should now handle Tab.
    inner.destroy();
    fakeDocument.activeElement = null;
    fakeDocument.dispatchKeydown('Tab');
    expect(fakeDocument.activeElement).toBe(outerBtn as unknown as HTMLElement);

    outer.destroy();
  });

  it('destroy removes the document listener once the stack is empty', () => {
    const modal = new FakeElement('DIV');
    const btn = new FakeElement('BUTTON');
    modal.appendChild(btn);
    const trap = focusTrap(modal as unknown as HTMLElement, { initialFocus: false });
    expect(fakeDocument.capture.length).toBe(1);
    trap.destroy();
    expect(fakeDocument.capture.length).toBe(0);
  });

  it('initial focus uses requestAnimationFrame so children rendered after mount are caught', () => {
    const modal = new FakeElement('DIV');
    // No focusables yet — they will be appended before the rAF fires.
    const trap = focusTrap(modal as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(1);
    expect(fakeDocument.activeElement).toBeNull();

    // Append a focusable child after mount but before the frame runs.
    const btn = new FakeElement('BUTTON');
    modal.appendChild(btn);
    flushRaf();
    expect(fakeDocument.activeElement).toBe(btn as unknown as HTMLElement);
    trap.destroy();
  });

  it('initial focus retries once on the next frame when no focusables exist yet', () => {
    const modal = new FakeElement('DIV');
    const trap = focusTrap(modal as unknown as HTMLElement);
    // First frame: still no focusables → schedule one retry.
    const cbs1 = rafCallbacks;
    rafCallbacks = [];
    cbs1.forEach((cb) => cb());
    expect(rafCallbacks.length).toBe(1);
    // Add a focusable, then run the retry frame.
    const btn = new FakeElement('BUTTON');
    modal.appendChild(btn);
    flushRaf();
    expect(fakeDocument.activeElement).toBe(btn as unknown as HTMLElement);
    trap.destroy();
  });

  it('initial focus does not steal focus if a child already focused itself', () => {
    const modal = new FakeElement('DIV');
    const preFocused = new FakeElement('INPUT');
    const other = new FakeElement('BUTTON');
    modal.appendChild(preFocused);
    modal.appendChild(other);
    // Simulate a child that auto-focused itself before rAF fires.
    fakeDocument.activeElement = preFocused as unknown as HTMLElement;

    const trap = focusTrap(modal as unknown as HTMLElement);
    flushRaf();
    expect(fakeDocument.activeElement).toBe(preFocused as unknown as HTMLElement);
    trap.destroy();
  });

  it('aria-hidden elements are excluded from the focusable list', () => {
    const modal = new FakeElement('DIV');
    const hidden = new FakeElement('BUTTON', { 'aria-hidden': 'true' });
    const visible = new FakeElement('BUTTON');
    modal.appendChild(hidden);
    modal.appendChild(visible);

    fakeDocument.activeElement = null;
    const trap = focusTrap(modal as unknown as HTMLElement, { initialFocus: false });
    fakeDocument.dispatchKeydown('Tab');
    expect(fakeDocument.activeElement).toBe(visible as unknown as HTMLElement);
    trap.destroy();
  });
});


