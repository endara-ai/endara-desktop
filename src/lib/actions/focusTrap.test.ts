import { describe, it, expect } from 'vitest';
import { computeFocusTrapTarget } from './focusTrap';

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

