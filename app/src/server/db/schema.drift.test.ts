import { getTableName } from 'drizzle-orm';
import { getTableConfig as pgConfig, type PgColumn } from 'drizzle-orm/pg-core';
import { getTableConfig as sqliteConfig, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { pgTables } from './schema.pg.ts';
import { tables } from './schema.ts';

type AnyColumn = SQLiteColumn | PgColumn;

const EXPECTED_TYPES: Record<string, string> = {
  SQLiteText: 'PgText',
  SQLiteInteger: 'PgInteger',
  SQLiteReal: 'PgDoublePrecision',
  SQLiteTimestamp: 'PgTimestamp',
  SQLiteBoolean: 'PgBoolean',
  SQLiteTextJson: 'PgJsonb',
};

/** Dialect-neutral description of a column's constraints. */
const column = (c: AnyColumn) => ({
  name: c.name,
  notNull: c.notNull,
  primary: c.primary,
  hasDefault: c.hasDefault,
  default: c.default,
  unique: c.isUnique ? (c.uniqueName ?? true) : false,
});

/** Dialect-neutral description of everything the schema promises about one table. */
function describeTable(
  config: ReturnType<typeof sqliteConfig> | ReturnType<typeof pgConfig>,
): unknown {
  const cfg = config as ReturnType<typeof sqliteConfig>;
  return {
    name: cfg.name,
    columns: cfg.columns.map(column),
    foreignKeys: cfg.foreignKeys
      .map((fk) => {
        const ref = fk.reference();
        return {
          name: fk.getName(),
          columns: ref.columns.map((c) => c.name),
          foreignTable: getTableName(ref.foreignTable),
          foreignColumns: ref.foreignColumns.map((c) => c.name),
          onDelete: fk.onDelete ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    indexes: cfg.indexes
      .map((idx) => ({
        name: idx.config.name,
        unique: idx.config.unique,
        columns: idx.config.columns.map((c) => (c as AnyColumn).name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    uniques: cfg.uniqueConstraints
      .map((u) => ({ name: u.name, columns: u.columns.map((c) => c.name) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    checks: cfg.checks.map((c) => c.name).sort(),
  };
}

const names = Object.keys(tables) as (keyof typeof tables)[];

describe('SQLite and derived Postgres schemas stay in lockstep', () => {
  it('define the same six tables', () => {
    expect(Object.keys(pgTables).sort()).toEqual(Object.keys(tables).sort());
    expect(names.map((n) => sqliteConfig(tables[n]).name).sort()).toEqual([
      'cargo_items',
      'players',
      'resource_node_state',
      'sessions',
      'ships',
      'system_registry',
    ]);
  });

  it.each(names)('%s has identical columns, defaults, keys, indexes and checks', (name) => {
    expect(describeTable(pgConfig(pgTables[name]))).toEqual(
      describeTable(sqliteConfig(tables[name])),
    );
  });

  it.each(names)('%s maps every column to the intended Postgres type', (name) => {
    const sqliteCols = sqliteConfig(tables[name]).columns;
    const pgCols = pgConfig(pgTables[name]).columns;
    expect(pgCols.map((c) => c.columnType)).toEqual(
      sqliteCols.map((c) => EXPECTED_TYPES[String(c.columnType)]),
    );
  });

  it('keeps the promised constraints (spot checks on the canonical schema)', () => {
    const players = describeTable(sqliteConfig(tables.players)) as { columns: { name: string }[] };
    expect(players.columns.map((c) => c.name)).toEqual([
      'id',
      'callsign',
      'credits',
      'home_system_id',
      'created_at',
    ]);
    const cargo = describeTable(sqliteConfig(tables.cargoItems)) as {
      uniques: { columns: string[] }[];
    };
    expect(cargo.uniques).toEqual([
      { name: 'cargo_items_ship_resource_unique', columns: ['ship_id', 'resource_type'] },
    ]);
  });
});
