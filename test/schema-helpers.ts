import {DatabaseSync} from 'node:sqlite';

import {stripSqlCommentsAndStrings} from '../db';

function extractNormalizedCheckConstraints(createTableSql: string | undefined): string[] {
  if (!createTableSql) return [];
  const stripped = stripSqlCommentsAndStrings(createTableSql);
  const checks: string[] = [];
  const checkRe = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = checkRe.exec(stripped)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '(') depth++;
      else if (stripped[i] === ')') depth--;
      i++;
    }
    if (depth === 0) {
      checks.push(createTableSql.slice(start, i - 1).trim().replace(/\s+/g, ' '));
    }
  }
  return checks.sort();
}

export function compareDatabaseSchemas(dbA: DatabaseSync, dbB: DatabaseSync): string[] {
  const inspect = (conn: DatabaseSync) => {
    const tables = conn.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`
    ).all() as Array<{name: string; sql: string | null}>;
    const snapshot = new Map<string, string>();
    for (const {name: table, sql: tableSql} of tables) {
      const cols = conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const fks = conn.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>;
      const rawIndexes = conn.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;
      const indexes = rawIndexes
        .filter(idx => idx.origin === 'c' || idx.origin === 'u')
        .map(idx => {
          const xinfo = conn.prepare(`PRAGMA index_xinfo("${idx.name}")`).all() as Array<{
            seqno: number;
            cid: number;
            name: string | null;
            desc: number;
            coll: string;
            key: number;
          }>;
          const keyCols = xinfo
            .filter(col => col.key === 1)
            .sort((a, b) => a.seqno - b.seqno)
            .map(col => `${col.name ?? '<expr>'}:${col.desc ? 'DESC' : 'ASC'}`);
          return {
            name: idx.origin === 'c' ? idx.name : '<unique>',
            unique: idx.unique,
            partial: idx.partial,
            cols: keyCols,
          };
        })
        .sort((x, y) =>
          `${x.name}:${x.unique}:${x.cols.join(',')}`
            .localeCompare(`${y.name}:${y.unique}:${y.cols.join(',')}`));
      snapshot.set(
        table,
        JSON.stringify({
          cols: cols.map(c => ({
            name: c.name,
            type: c.type.toUpperCase(),
            notnull: c.notnull,
            dflt: c.dflt_value ?? undefined,
            pk: c.pk,
          })),
          fks: fks
            .map(f => ({
              table: f.table,
              from: f.from,
              to: f.to,
              onUpdate: f.on_update,
              onDelete: f.on_delete,
            }))
            .sort((x, y) =>
              `${x.from}:${x.table}.${x.to}`.localeCompare(`${y.from}:${y.table}.${y.to}`)),
          indexes,
          checks: extractNormalizedCheckConstraints(tableSql ?? undefined),
        })
      );
    }
    return snapshot;
  };

  const snapA = inspect(dbA);
  const snapB = inspect(dbB);
  const allTables = [...new Set([...snapA.keys(), ...snapB.keys()])].sort();
  const diffs: string[] = [];
  for (const table of allTables) {
    const a = snapA.get(table);
    const b = snapB.get(table);
    if (a === undefined) {
      diffs.push(`table "${table}" missing in first schema`);
    } else if (b === undefined) {
      diffs.push(`table "${table}" missing in second schema`);
    } else if (a !== b) {
      diffs.push(`table "${table}" definition mismatch: ${a} vs ${b}`);
    }
  }
  return diffs;
}
