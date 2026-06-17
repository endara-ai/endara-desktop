import type { ObservabilityConfig } from '$lib/types';

/**
 * Default observability configuration. Mirrors the relay's
 * `ObservabilityConfig::default` (config.rs) so a freshly-mounted Settings
 * section shows the same values the relay would fall back to when the
 * `[relay.observability]` table is absent from `config.toml`.
 */
export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enabled: true,
  store_payloads: true,
  payload_window_minutes: 10,
  record_retention_days: 7,
  max_db_size_mb: 1024,
  max_payload_bytes: 262144,
  payload_buffer_budget_mb: 128,
};

/** Numeric `ObservabilityConfig` keys (the relay types them as `u64`). */
export type ObservabilityNumericKey =
  | 'payload_window_minutes'
  | 'record_retention_days'
  | 'max_db_size_mb'
  | 'max_payload_bytes'
  | 'payload_buffer_budget_mb';

/**
 * UI metadata for one numeric control in the Observability Settings section.
 * `payloadRelated` rows are greyed out / disabled when payload capture is off
 * (either `enabled` or `store_payloads` is false) because they only affect the
 * payload ring buffer; the metadata-only rows stay live whenever observability
 * itself is enabled.
 */
export interface ObservabilityNumericField {
  key: ObservabilityNumericKey;
  label: string;
  unit: string;
  min: number;
  hint: string;
  payloadRelated: boolean;
}

export const OBSERVABILITY_NUMERIC_FIELDS: readonly ObservabilityNumericField[] = [
  {
    key: 'record_retention_days',
    label: 'Record retention',
    unit: 'days',
    min: 1,
    hint: 'How long metadata rows are kept before eviction.',
    payloadRelated: false,
  },
  {
    key: 'max_db_size_mb',
    label: 'Max database size',
    unit: 'MB',
    min: 1,
    hint: 'On-disk cap for the metadata database; oldest rows are evicted first.',
    payloadRelated: false,
  },
  {
    key: 'payload_window_minutes',
    label: 'Payload window',
    unit: 'minutes',
    min: 1,
    hint: 'How long captured payloads stay retrievable before they expire.',
    payloadRelated: true,
  },
  {
    key: 'max_payload_bytes',
    label: 'Max payload size',
    unit: 'bytes',
    min: 1,
    hint: 'Payloads larger than this are truncated and flagged.',
    payloadRelated: true,
  },
  {
    key: 'payload_buffer_budget_mb',
    label: 'Payload buffer budget',
    unit: 'MB',
    min: 1,
    hint: 'Total memory budget for the in-memory payload ring buffer.',
    payloadRelated: true,
  },
];

/**
 * Whether a numeric field should be editable given the current toggle state.
 * Metadata fields need observability `enabled`; payload fields additionally
 * need `store_payloads`.
 */
export function isFieldEnabled(
  field: ObservabilityNumericField,
  cfg: Pick<ObservabilityConfig, 'enabled' | 'store_payloads'>,
): boolean {
  if (!cfg.enabled) return false;
  return field.payloadRelated ? cfg.store_payloads : true;
}

/**
 * Validate a single numeric value against its field rules. Returns `null` when
 * acceptable, otherwise a short inline error message. The relay stores these as
 * `u64`, so values must be finite, integral, and at least the field minimum.
 */
export function validateObservabilityField(
  field: ObservabilityNumericField,
  value: number,
): string | null {
  if (!Number.isFinite(value)) return `${field.label} must be a number`;
  if (!Number.isInteger(value)) return `${field.label} must be a whole number`;
  if (value < field.min) return `${field.label} must be at least ${field.min} ${field.unit}`;
  return null;
}

/**
 * Validate every numeric field, returning a map of field key → error message
 * for the invalid ones. An empty object means the config is safe to PUT.
 */
export function validateObservabilityConfig(
  cfg: ObservabilityConfig,
): Partial<Record<ObservabilityNumericKey, string>> {
  const errors: Partial<Record<ObservabilityNumericKey, string>> = {};
  for (const field of OBSERVABILITY_NUMERIC_FIELDS) {
    const err = validateObservabilityField(field, cfg[field.key]);
    if (err) errors[field.key] = err;
  }
  return errors;
}

/** Whether the edited config differs from the loaded baseline. */
export function isObservabilityConfigDirty(
  current: ObservabilityConfig,
  baseline: ObservabilityConfig,
): boolean {
  return (
    current.enabled !== baseline.enabled ||
    current.store_payloads !== baseline.store_payloads ||
    OBSERVABILITY_NUMERIC_FIELDS.some((f) => current[f.key] !== baseline[f.key])
  );
}

/**
 * Coerce a raw `<input type="number">` string into an integer for storage,
 * flooring fractional input and falling back to `min` when the value is blank
 * or non-numeric so the bound state never holds `NaN`.
 */
export function coerceObservabilityNumber(
  field: ObservabilityNumericField,
  raw: string,
): number {
  if (raw.trim() === '') return field.min;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return field.min;
  return Math.floor(parsed);
}
