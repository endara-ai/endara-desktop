// The overlay window loads a fully static, prerendered route. There's no
// dynamic data fetched at request time — the renderer subscribes to the
// `tool-call-event` Tauri event stream and renders cards client-side.
export const prerender = true;
export const ssr = false;
