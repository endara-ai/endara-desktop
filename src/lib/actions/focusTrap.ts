// Focus-trap action for modal containers. Tab/Shift+Tab cycle within the
// node's focusable descendants instead of escaping to elements behind the
// modal. Escape is intercepted only when the trap is given an explicit
// `onEscape` callback — otherwise it falls through.
//
// The keydown listener is attached at the document level in the capture
// phase so we intercept Tab even when focus is still on the trigger button
// that just opened the modal (i.e. before any element inside the modal has
// received focus). A module-scoped stack ensures that with nested modals
// only the top trap handles Tab/Escape.
//
// Capture-phase Escape handling is also what makes this work for modals
// whose inner dialog div has `onkeydown={(e) => e.stopPropagation()}` to
// keep stray keys from reaching global app shortcuts: our document-level
// listener fires before any bubble-phase stopPropagation can swallow it.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusables(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      el.offsetParent !== null,
  );
}

// Pure helper that decides what to focus next when Tab/Shift+Tab is pressed.
// Returns the element to focus, or `null` when the browser's default Tab
// behavior should run (focus is mid-list and there's nothing to wrap).
//
// Exported so that the logic can be unit-tested without mounting a real
// modal — same pattern as the other helpers next to AddEndpointModal.
export function computeFocusTrapTarget(
  focusables: HTMLElement[],
  current: HTMLElement | null,
  shiftKey: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const idx = current ? focusables.indexOf(current) : -1;
  if (idx === -1) {
    // Focus is outside the trap (or on the container itself) — pull it in.
    return shiftKey ? last : first;
  }
  if (shiftKey && current === first) return last;
  if (!shiftKey && current === last) return first;
  return null;
}

export interface FocusTrapOptions {
  // When true (default), focuses the first focusable on mount so the user's
  // keyboard lands inside the modal. Pass `false` to leave initial focus
  // alone — useful if the modal already focuses a specific input itself.
  initialFocus?: boolean;
  // When provided, Escape pressed while this trap is on top of the stack
  // calls this callback (and the event is preventDefaulted + stopPropagated
  // so other listeners don't double-fire). When omitted, Escape passes
  // through unmodified.
  onEscape?: () => void;
}

// ── Module-scoped trap stack ──
// Multiple modals can be open at once (e.g. a ConfirmModal layered over an
// AddEndpointModal); only the top trap handles Tab/Escape so the user is
// always constrained to the foreground modal and nested modals dismiss in
// LIFO order.
interface TrapEntry {
  node: HTMLElement;
  onEscape?: () => void;
}
const trapStack: TrapEntry[] = [];
let documentListenerInstalled = false;

function onDocumentKeydown(event: KeyboardEvent) {
  const top = trapStack[trapStack.length - 1];
  if (!top) return;
  if (event.key === 'Tab') {
    const focusables = getFocusables(top.node);
    const target = computeFocusTrapTarget(
      focusables,
      document.activeElement as HTMLElement | null,
      event.shiftKey,
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  } else if (event.key === 'Escape') {
    if (top.onEscape) {
      top.onEscape();
      event.preventDefault();
      event.stopPropagation();
    }
  }
}

function installListener() {
  if (documentListenerInstalled) return;
  document.addEventListener('keydown', onDocumentKeydown, true);
  documentListenerInstalled = true;
}

function uninstallListenerIfIdle() {
  if (!documentListenerInstalled || trapStack.length > 0) return;
  document.removeEventListener('keydown', onDocumentKeydown, true);
  documentListenerInstalled = false;
}

export function focusTrap(node: HTMLElement, options: FocusTrapOptions = {}) {
  const { initialFocus = true, onEscape } = options;
  const entry: TrapEntry = { node, onEscape };
  trapStack.push(entry);
  installListener();

  if (initialFocus) {
    // requestAnimationFrame instead of queueMicrotask: in Svelte 5, modal
    // children may not be in the DOM yet at microtask time. Retry once on
    // the next frame if focusables aren't ready (e.g. async-rendered
    // subtrees) but don't loop indefinitely.
    let attempts = 0;
    const tryFocus = () => {
      if (node.contains(document.activeElement)) return;
      const focusables = getFocusables(node);
      if (focusables.length > 0) {
        focusables[0].focus();
        return;
      }
      attempts += 1;
      if (attempts < 2) requestAnimationFrame(tryFocus);
    };
    requestAnimationFrame(tryFocus);
  }

  return {
    destroy() {
      const idx = trapStack.indexOf(entry);
      if (idx !== -1) trapStack.splice(idx, 1);
      uninstallListenerIfIdle();
    },
  };
}

