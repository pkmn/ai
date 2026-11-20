import {DatabaseSync} from 'node:sqlite';

function stripSqlCommentsKeepLiterals(sql: string): {uncommented: string; scan: string} {
  let uncommented = '';
  let scan = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      i = sql.indexOf('\n', i + 2);
      if (i === -1) break;
      uncommented += '\n';
      scan += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      uncommented += ' ';
      scan += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      uncommented += ch;
      scan += ch;
      for (i++; i < sql.length; i++) {
        const c = sql[i];
        uncommented += c;
        if (c === quote) {
          if (sql[i + 1] === quote) {
            i++;
            uncommented += sql[i];
            scan += quote === "'" ? '  ' : `${c}${sql[i]}`;
            continue;
          }
          scan += c;
          break;
        }
        scan += quote === "'" ? ' ' : c;
      }
      continue;
    }
    uncommented += ch;
    scan += ch;
  }
  return {uncommented, scan};
}

function extractNormalizedCheckConstraints(createTableSql: string | undefined): string[] {
  if (!createTableSql) return [];
  const {uncommented, scan} = stripSqlCommentsKeepLiterals(createTableSql);
  const checks: string[] = [];
  const checkRe = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = checkRe.exec(scan)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < scan.length && depth > 0) {
      if (scan[i] === '(') depth++;
      else if (scan[i] === ')') depth--;
      i++;
    }
    if (depth === 0) {
      checks.push(uncommented.slice(start, i - 1).trim().replace(/\s+/g, ' '));
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
