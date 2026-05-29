// The overlay window loads a fully static, prerendered route. There's no
// dynamic data fetched at request time — the renderer subscribes to the
// `tool-call-event` Tauri event stream and renders cards client-side.
export const prerender = true;
export const ssr = false;
// Emit `build/overlay/index.html` instead of `build/overlay.html` so the
// same URL (`overlay/`) resolves in both dev mode (SvelteKit/Vite route at
// `/overlay/`) and prod mode (Tauri's asset protocol maps a directory path
// to its `index.html`). See `src-tauri/src/overlay.rs::build_overlay_window`.
export const trailingSlash = 'always';
