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

// Mirrors the relay's `ClientIdentity` struct (see
// `packages/relay/src/events.rs`). All fields are independently optional —
// the on-wire JSON omits any `None` field, so the renderer must treat
// "missing key" and "null" as the same "no value" state.
export type ClientIdentity = {
  name?: string | null;
  version?: string | null;
  user_agent?: string | null;
  origin?: string | null;
  // Friendly display label the relay serializes for the embedded `client`
  // object (see the custom `Serialize` on `ClientIdentity` in
  // `packages/relay/src/events.rs`); preferred over the raw `name`.
  label?: string | null;
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
  // Relay-minted per-HTTP-request UUID (see `request_uid` on the relay's
  // `request` tracing span). This is the canonical key the overlay card click
  // handler uses to focus the matching log row in the main window —
  // collision-free across multiple MCP clients sending the same JSON-RPC id
  // concurrently. The relay always emits it on Started events.
  request_uid: string;
  // JSON-RPC envelope id captured from the surrounding `request` span. Retained
  // on the wire for diagnostic context only; no longer used as the row/card key.
  jsonrpc_id?: string | null;
  tool: string;
  annotations?: ToolCallAnnotations;
  // Identity of the calling MCP client. Omitted by the relay when no caller
  // signal is known; treat "missing key" and "null" as the same "no caller".
  client?: ClientIdentity | null;
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
