import { describe, it, expect } from 'vitest';
import type { ObservabilityConfig } from '$lib/types';
import {
  DEFAULT_OBSERVABILITY_CONFIG,
  OBSERVABILITY_NUMERIC_FIELDS,
  coerceObservabilityNumber,
  isFieldEnabled,
  isObservabilityConfigDirty,
  validateObservabilityConfig,
  validateObservabilityField,
  type ObservabilityNumericField,
} from './observability-settings-helpers';

function cfg(overrides: Partial<ObservabilityConfig> = {}): ObservabilityConfig {
  return { ...DEFAULT_OBSERVABILITY_CONFIG, ...overrides };
}

const fieldByKey = (key: ObservabilityNumericField['key']) =>
  OBSERVABILITY_NUMERIC_FIELDS.find((f) => f.key === key)!;

describe('DEFAULT_OBSERVABILITY_CONFIG', () => {
  it('matches the relay defaults', () => {
    expect(DEFAULT_OBSERVABILITY_CONFIG).toEqual({
      enabled: true,
      store_payloads: true,
      payload_window_minutes: 10,
      record_retention_days: 7,
      max_db_size_mb: 1024,
      max_payload_bytes: 262144,
      payload_buffer_budget_mb: 128,
    });
  });
});

describe('isFieldEnabled', () => {
  const metadataField = fieldByKey('record_retention_days');
  const payloadField = fieldByKey('payload_window_minutes');

  it('disables every field when observability is off', () => {
    const state = { enabled: false, store_payloads: true };
    expect(isFieldEnabled(metadataField, state)).toBe(false);
    expect(isFieldEnabled(payloadField, state)).toBe(false);
  });

  it('keeps metadata fields live but disables payload fields when store_payloads is off', () => {
    const state = { enabled: true, store_payloads: false };
    expect(isFieldEnabled(metadataField, state)).toBe(true);
    expect(isFieldEnabled(payloadField, state)).toBe(false);
  });

  it('enables all fields when enabled and store_payloads are on', () => {
    const state = { enabled: true, store_payloads: true };
    expect(isFieldEnabled(metadataField, state)).toBe(true);
    expect(isFieldEnabled(payloadField, state)).toBe(true);
  });
});

describe('validateObservabilityField', () => {
  const field = fieldByKey('payload_window_minutes');

  it('accepts an integer at or above the minimum', () => {
    expect(validateObservabilityField(field, 1)).toBeNull();
    expect(validateObservabilityField(field, 30)).toBeNull();
  });

  it('rejects values below the minimum', () => {
    expect(validateObservabilityField(field, 0)).toMatch(/at least 1 minutes/);
  });

  it('rejects non-integers', () => {
    expect(validateObservabilityField(field, 1.5)).toMatch(/whole number/);
  });

  it('rejects NaN', () => {
    expect(validateObservabilityField(field, Number.NaN)).toMatch(/must be a number/);
  });
});

describe('validateObservabilityConfig', () => {
  it('returns no errors for a valid config', () => {
    expect(validateObservabilityConfig(cfg())).toEqual({});
  });

  it('flags every invalid numeric field', () => {
    const errors = validateObservabilityConfig(
      cfg({ payload_window_minutes: 0, max_db_size_mb: -5 }),
    );
    expect(Object.keys(errors).sort()).toEqual(['max_db_size_mb', 'payload_window_minutes']);
  });
});

describe('isObservabilityConfigDirty', () => {
  it('is false for identical configs', () => {
    expect(isObservabilityConfigDirty(cfg(), cfg())).toBe(false);
  });

  it('detects a toggle change', () => {
    expect(isObservabilityConfigDirty(cfg({ enabled: false }), cfg())).toBe(true);
    expect(isObservabilityConfigDirty(cfg({ store_payloads: false }), cfg())).toBe(true);
  });

  it('detects a numeric change', () => {
    expect(isObservabilityConfigDirty(cfg({ max_db_size_mb: 512 }), cfg())).toBe(true);
  });
});

describe('coerceObservabilityNumber', () => {
  const field = fieldByKey('max_payload_bytes');

  it('floors fractional input', () => {
    expect(coerceObservabilityNumber(field, '1024.9')).toBe(1024);
  });

  it('falls back to the field minimum for blank or non-numeric input', () => {
    expect(coerceObservabilityNumber(field, '')).toBe(field.min);
    expect(coerceObservabilityNumber(field, 'abc')).toBe(field.min);
  });

  it('passes a clean integer through unchanged', () => {
    expect(coerceObservabilityNumber(field, '4096')).toBe(4096);
  });
});
