// TypeScript shape of the relay's `ToolCallEvent` enum (see
// `packages/relay/src/events.rs`). The bus emits one of three variants tagged
// by `kind`; the overlay routes `started` → store.addStarted and the terminal
// variants (`completed` / `failed`) → store.settle.
//
// Field names mirror the Rust struct exactly (snake_case) because the Tauri
// `tool-call-event` payload is the raw `serde_json::Value` forwarded from the
// SSE bridge — no camelCase transform happens between Rust and JS.

export type ToolCallAnnotations = {
  destructive?: boolean;
  open_world?: boolean;
  read_only?: boolean;
  idempotent?: boolean;
};

export type StartedEvent = {
  kind: 'started';
  request_id: string;
  ts: string;
  endpoint: string;
  transport: string;
  // Relay omits these via `skip_serializing_if = Option::is_none`. The renderer
  // must treat "missing key" and "null" as the same "no value" state.
  server_type?: string | null;
  server_name?: string | null;
  profile?: string | null;
  // JSON-RPC envelope id captured from the surrounding `request` span. Used by
  // the overlay card click handler to focus the matching `request{id="..."}`
  // log row in the main window. `None` when no `request` span was on the stack
  // when the event was emitted (e.g. internal callers).
  jsonrpc_id?: string | null;
  tool: string;
  annotations?: ToolCallAnnotations;
};

export type CompletedEvent = {
  kind: 'completed';
  request_id: string;
  ts: string;
  duration_ms: number;
  status: 'ok' | 'error';
  jsonrpc_id?: string | null;
};

export type FailedEvent = {
  kind: 'failed';
  request_id: string;
  ts: string;
  duration_ms: number;
  status: 'error';
  error_message?: string;
  jsonrpc_id?: string | null;
};

export type ToolCallEvent = StartedEvent | CompletedEvent | FailedEvent;
