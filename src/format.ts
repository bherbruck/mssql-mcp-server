// Canonical type mapping and row value normalization.
//
// The MCP layer should hand Claude predictable JSON: dates as ISO strings,
// binary as base64, NULL as JSON null, and a stable set of `type` names.

export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
}

// Translate a node-mssql column descriptor (or our stub's equivalent) into a
// compact canonical type string. The shape of input.type varies by driver
// version, so we sniff a few likely fields.
export function canonicalType(input: {
  type?: { name?: string } | string;
  length?: number;
  scale?: number;
  precision?: number;
}): string {
  const raw = typeof input.type === 'string'
    ? input.type
    : (input.type?.name ?? 'unknown');
  const name = raw.toLowerCase();
  const len = input.length;
  const p = input.precision;
  const s = input.scale;

  switch (name) {
    case 'int':
    case 'smallint':
    case 'tinyint':
    case 'bigint':
    case 'bit':
    case 'real':
    case 'float':
    case 'money':
    case 'smallmoney':
    case 'date':
    case 'datetime':
    case 'datetime2':
    case 'datetimeoffset':
    case 'smalldatetime':
    case 'time':
    case 'uniqueidentifier':
    case 'xml':
    case 'json':
    case 'text':
    case 'ntext':
    case 'image':
      return name;
    case 'decimal':
    case 'numeric':
      return p !== undefined ? `${name}(${p},${s ?? 0})` : name;
    case 'char':
    case 'nchar':
    case 'varchar':
    case 'nvarchar':
    case 'binary':
    case 'varbinary': {
      const display = len === undefined || len < 0 ? 'max' : String(len);
      return `${name}(${display})`;
    }
    default:
      return name;
  }
}

// Normalize a single row's values for JSON serialization.
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = normalizeValue(v);
  }
  return out;
}

export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Buffer) return v.toString('base64');
  if (typeof v === 'bigint') return v.toString();
  return v;
}
