import {
  listAliasesQuerySchema,
  listQuarantineQuerySchema,
  type ListAliasesQuery,
  type ListQuarantineQuery,
} from "wickmail-core";

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function coerceBoolean(value: unknown): boolean | undefined {
  const single = firstValue(value);
  if (single === undefined) return undefined;
  if (single === true || single === "true" || single === "1") return true;
  if (single === false || single === "false" || single === "0") return false;
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  const single = firstValue(value);
  if (single === undefined) return undefined;
  if (typeof single === "number") return single;
  if (typeof single === "string" && single.trim().length > 0) {
    const parsed = Number(single);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  const single = firstValue(value);
  if (single === undefined) return undefined;
  return typeof single === "string" ? single : undefined;
}

function pickDefined(entries: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Parse and validate `GET /v1/aliases` query parameters. */
export function parseListAliasesQuery(raw: unknown): ListAliasesQuery {
  const source = asRecord(raw);
  return listAliasesQuerySchema.parse(
    pickDefined({
      state: coerceString(source.state),
      hasExpiry: coerceBoolean(source.hasExpiry),
      expiresBefore: coerceString(source.expiresBefore),
      expiresAfter: coerceString(source.expiresAfter),
      search: coerceString(source.search),
      sort: coerceString(source.sort),
      order: coerceString(source.order),
      limit: coerceNumber(source.limit),
      cursor: coerceString(source.cursor),
    }),
  );
}

/** Parse and validate `GET /v1/quarantine` query parameters. */
export function parseListQuarantineQuery(raw: unknown): ListQuarantineQuery {
  const source = asRecord(raw);
  return listQuarantineQuerySchema.parse(
    pickDefined({
      status: coerceString(source.status),
      aliasId: coerceString(source.aliasId),
      search: coerceString(source.search),
      sort: coerceString(source.sort),
      order: coerceString(source.order),
      limit: coerceNumber(source.limit),
      cursor: coerceString(source.cursor),
    }),
  );
}
