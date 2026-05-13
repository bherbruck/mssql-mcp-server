import { describe, it, expect } from 'vitest';
import { canonicalType, normalizeRow, normalizeValue } from '../src/format.js';

describe('canonicalType', () => {
  it('passes through simple types', () => {
    expect(canonicalType({ type: { name: 'int' } })).toBe('int');
    expect(canonicalType({ type: { name: 'bigint' } })).toBe('bigint');
    expect(canonicalType({ type: { name: 'bit' } })).toBe('bit');
    expect(canonicalType({ type: { name: 'datetime2' } })).toBe('datetime2');
  });

  it('decorates decimal with precision and scale', () => {
    expect(canonicalType({ type: { name: 'decimal' }, precision: 12, scale: 2 })).toBe('decimal(12,2)');
    expect(canonicalType({ type: { name: 'numeric' }, precision: 18 })).toBe('numeric(18,0)');
  });

  it('decorates string types with length', () => {
    expect(canonicalType({ type: { name: 'varchar' }, length: 64 })).toBe('varchar(64)');
    expect(canonicalType({ type: { name: 'nvarchar' }, length: -1 })).toBe('nvarchar(max)');
  });

  it('handles string type passthrough', () => {
    expect(canonicalType({ type: 'int' })).toBe('int');
  });
});

describe('normalizeValue', () => {
  it('converts Date to ISO string', () => {
    const d = new Date('2025-01-15T10:30:00.000Z');
    expect(normalizeValue(d)).toBe('2025-01-15T10:30:00.000Z');
  });

  it('base64-encodes Buffer', () => {
    const b = Buffer.from('hello', 'utf-8');
    expect(normalizeValue(b)).toBe('aGVsbG8=');
  });

  it('stringifies BigInt', () => {
    expect(normalizeValue(BigInt('9007199254740993'))).toBe('9007199254740993');
  });

  it('passes through primitives and null/undefined as null', () => {
    expect(normalizeValue(null)).toBe(null);
    expect(normalizeValue(undefined)).toBe(null);
    expect(normalizeValue(42)).toBe(42);
    expect(normalizeValue('hi')).toBe('hi');
    expect(normalizeValue(true)).toBe(true);
  });
});

describe('normalizeRow', () => {
  it('normalizes all keys of an object', () => {
    const d = new Date('2025-01-15T10:30:00.000Z');
    const row = { id: 1, ts: d, label: null, blob: Buffer.from('xy'), big: BigInt(10) };
    expect(normalizeRow(row)).toEqual({
      id: 1,
      ts: '2025-01-15T10:30:00.000Z',
      label: null,
      blob: 'eHk=',
      big: '10',
    });
  });
});
