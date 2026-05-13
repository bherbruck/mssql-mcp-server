// Standard error codes the server emits. The MCP transport surfaces these in
// the tool response payload — clients (e.g. Claude) read `error.code` and
// `error.hint` to recover.

export type ErrorCode =
  | 'SERVER_NOT_FOUND'
  | 'SERVER_REQUIRED'
  | 'DATABASE_NOT_FOUND'
  | 'OBJECT_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'SYNTAX_ERROR'
  | 'PARAM_BIND_ERROR'
  | 'CONNECTION_FAILED'
  | 'INVALID_CONFIRM_TOKEN'
  | 'WRITE_NOT_ENABLED'
  | 'INTERNAL_ERROR';

export interface ToolError {
  code: ErrorCode;
  message: string;
  sql_state?: string;
  sql_error_number?: number;
  line?: number;
  hint?: string;
}

export class McpToolError extends Error {
  code: ErrorCode;
  sql_state?: string;
  sql_error_number?: number;
  line?: number;
  hint?: string;

  constructor(code: ErrorCode, message: string, extra: Partial<ToolError> = {}) {
    super(message);
    this.code = code;
    this.sql_state = extra.sql_state;
    this.sql_error_number = extra.sql_error_number;
    this.line = extra.line;
    this.hint = extra.hint;
  }

  toJSON(): { error: ToolError } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.sql_state !== undefined ? { sql_state: this.sql_state } : {}),
        ...(this.sql_error_number !== undefined ? { sql_error_number: this.sql_error_number } : {}),
        ...(this.line !== undefined ? { line: this.line } : {}),
        ...(this.hint !== undefined ? { hint: this.hint } : {}),
      },
    };
  }
}

// Translate a thrown error (usually from the mssql driver) into our envelope.
export function toToolError(err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;

  // node-mssql / tedious shape: { code, number, state, lineNumber, message, originalError }
  const e = err as Record<string, unknown>;
  const number = typeof e?.number === 'number' ? (e.number as number) : undefined;
  const state = typeof e?.state === 'string' ? (e.state as string) : undefined;
  const lineNumber = typeof e?.lineNumber === 'number' ? (e.lineNumber as number) : undefined;
  const driverCode = typeof e?.code === 'string' ? (e.code as string) : '';
  const message = typeof e?.message === 'string' ? (e.message as string) : String(err);

  // Heuristic mapping. We deliberately leave the original message intact.
  let code: ErrorCode = 'INTERNAL_ERROR';
  let hint: string | undefined;

  if (number === 208 || /Invalid object name/i.test(message)) {
    code = 'OBJECT_NOT_FOUND';
    hint = 'Use search_objects(pattern) to find the correct name, or list_objects to browse.';
  } else if (number === 207 || /Invalid column name/i.test(message)) {
    code = 'OBJECT_NOT_FOUND';
    hint = 'Call describe_object(name) to see the available columns.';
  } else if (number === 229 || number === 230 || /permission was denied/i.test(message)) {
    code = 'PERMISSION_DENIED';
  } else if (driverCode === 'ETIMEOUT' || /timeout/i.test(message)) {
    code = 'TIMEOUT';
    hint = 'Raise timeout_ms, narrow the WHERE clause, or check explain_query for a missing index.';
  } else if (number === 102 || number === 156 || /syntax/i.test(message)) {
    code = 'SYNTAX_ERROR';
  } else if (/EREQUEST|param/i.test(driverCode) || /parameter/i.test(message)) {
    code = 'PARAM_BIND_ERROR';
  } else if (driverCode.startsWith('ELOGIN') || driverCode === 'ESOCKET' || /login failed|cannot connect/i.test(message)) {
    code = 'CONNECTION_FAILED';
  }

  return new McpToolError(code, message, {
    sql_state: state,
    sql_error_number: number,
    line: lineNumber,
    hint,
  });
}
