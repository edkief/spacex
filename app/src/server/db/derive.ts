import { is } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
  type PgColumnBuilderBase,
  type PgTable,
} from 'drizzle-orm/pg-core';
import { SQLiteColumn, getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';

type AnyPgColumnTuple = [AnyPgColumn, ...AnyPgColumn[]];

/** Maps a SQLite column (by drizzle columnType) to its Postgres builder, applying constraints. */
function deriveColumn(column: SQLiteColumn): PgColumnBuilderBase {
  const name = column.name;
  let builder;
  switch (column.columnType) {
    case 'SQLiteText':
      builder = text(name);
      break;
    case 'SQLiteInteger':
      builder = integer(name);
      break;
    case 'SQLiteReal':
      builder = doublePrecision(name);
      break;
    case 'SQLiteTimestamp':
      builder = timestamp(name, { withTimezone: true, mode: 'date' });
      break;
    case 'SQLiteBoolean':
      builder = boolean(name);
      break;
    case 'SQLiteTextJson':
      builder = jsonb(name);
      break;
    default:
      throw new Error(`derive: unsupported column type ${column.columnType} (${name})`);
  }
  if (column.defaultFn || column.onUpdateFn) {
    throw new Error(`derive: runtime defaults are not portable (${name}); set values in code`);
  }
  if (column.notNull) builder = builder.notNull();
  if (column.primary) builder = builder.primaryKey();
  if (column.isUnique) builder = builder.unique(column.uniqueName ?? undefined);
  if (column.hasDefault) builder = builder.default(column.default as never);
  return builder;
}

/** Returns the property-name -> column map of a table object. */
function columnsByKey(table: SQLiteTable): Record<string, SQLiteColumn> {
  return Object.fromEntries(
    Object.entries(table).filter((entry): entry is [string, SQLiteColumn] =>
      is(entry[1], SQLiteColumn),
    ),
  );
}

/**
 * Derives the Postgres tables from the canonical SQLite definitions: same names, columns,
 * nullability, defaults, primary keys, uniques, foreign keys (with ON DELETE), indexes and check
 * constraints. Throws on any construct it does not know how to translate, so a new column kind
 * can never silently diverge.
 */
export function derivePgTables<T extends Record<string, SQLiteTable>>(
  source: T,
): Record<keyof T, PgTable> {
  const result = {} as Record<string, PgTable>;
  const keyOf = new Map<SQLiteColumn, { table: string; key: string }>();
  for (const [tableKey, table] of Object.entries(source)) {
    for (const [key, column] of Object.entries(columnsByKey(table))) {
      keyOf.set(column, { table: tableKey, key });
    }
  }

  for (const [tableKey, table] of Object.entries(source)) {
    const config = getTableConfig(table);
    const columns = Object.fromEntries(
      Object.entries(columnsByKey(table)).map(([key, column]) => [key, deriveColumn(column)]),
    );
    result[tableKey] = pgTable(config.name, columns, (self) => {
      const pg = self as Record<string, AnyPgColumn>;
      const pgColumn = (column: SQLiteColumn): AnyPgColumn => {
        const location = keyOf.get(column);
        if (!location) throw new Error(`derive: unknown column ${column.name}`);
        const owner = result[location.table] as unknown as Record<string, AnyPgColumn>;
        return location.table === tableKey
          ? (pg[location.key] as AnyPgColumn)
          : owner[location.key]!;
      };
      const extras = [];
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        const builder = foreignKey({
          name: fk.getName(),
          columns: ref.columns.map((c) => pgColumn(c)) as AnyPgColumnTuple,
          foreignColumns: ref.foreignColumns.map((c) => pgColumn(c)) as AnyPgColumnTuple,
        });
        extras.push(fk.onDelete ? builder.onDelete(fk.onDelete) : builder);
      }
      for (const idx of config.indexes) {
        const cols = idx.config.columns.map((c) => pgColumn(c as SQLiteColumn));
        if (cols.length === 0) throw new Error(`derive: empty index ${idx.config.name}`);
        extras.push(index(idx.config.name).on(...(cols as AnyPgColumnTuple)));
      }
      for (const uq of config.uniqueConstraints) {
        const cols = uq.columns.map((c) => pgColumn(c));
        if (cols.length === 0) throw new Error(`derive: empty unique ${uq.name ?? '?'}`);
        extras.push(unique(uq.name).on(...(cols as AnyPgColumnTuple)));
      }
      for (const chk of config.checks) extras.push(check(chk.name, chk.value));
      return extras;
    });
  }
  return result as Record<keyof T, PgTable>;
}
