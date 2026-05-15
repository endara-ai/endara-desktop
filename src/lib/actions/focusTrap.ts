// Focus-trap action for modal containers. Tab/Shift+Tab cycle within the
// node's focusable descendants instead of escaping to elements behind the
// modal. Escape handling is intentionally left to the modal itself — this
// action only intercepts Tab.
//
// We rolled our own (~30 LOC) instead of pulling in `svelte-focus-trap`
// because that library binds `home`, `end`, `up`, `down`, and `alt+tab` at
// the document level via Mousetrap, which would break normal text-input
// navigation inside our many-input modals.

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
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
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
}

export function focusTrap(node: HTMLElement, options: FocusTrapOptions = {}) {
  const { initialFocus = true } = options;

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const focusables = getFocusables(node);
    const target = computeFocusTrapTarget(
      focusables,
      document.activeElement as HTMLElement | null,
      event.shiftKey,
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  node.addEventListener('keydown', handleKeydown);

  if (initialFocus) {
    // Defer so the modal's `tabindex="-1"` container isn't the only thing
    // focusable yet — wait a microtask for the children to render.
    queueMicrotask(() => {
      const focusables = getFocusables(node);
      if (focusables.length > 0 && !node.contains(document.activeElement)) {
        focusables[0].focus();
      }
    });
  }

  return {
    destroy() {
      node.removeEventListener('keydown', handleKeydown);
    },
  };
}

