import { extractSqlStatement } from '../../src/sql-statement.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

function extract(query: string): string | undefined {
  const db = new DatabaseSync(':memory:')

  try {
    return extractSqlStatement(query, db.prepare(query).sourceSQL)
  } finally {
    db.close()
  }
}

test.each([
  { expected: 'SELECT 1', query: 'SELECT 1 /* trailing */' },
  { expected: 'SELECT 1', query: '/* leading */ ; SELECT 1 /* before */; /* after */ -- end' },
  { expected: 'SELECT 1 /* inner */ + 2', query: 'SELECT 1 /* inner */ + 2;\t\r\n\u00a0' },
  { expected: 'SELECT 1 AS \u00a0', query: 'SELECT 1 AS \u00a0 /* trailing */' },
  { expected: 'SELECT 1', query: 'SELECT 1; -- not a line break\rSELECT 2 /* ignored' },
  { expected: 'SELECT 1', query: 'SELECT 1 -- not a line break\rSELECT 2 /* ignored' },
  { expected: 'SELECT 1', query: 'SELECT 1; /* open /* not nested */ -- end' },
  { expected: "SELECT 'é''/*;--'", query: "SELECT 'é''/*;--'; /* end */" },
  {
    expected: 'SELECT 1 AS "a""/*;--", 2 AS `b``/*;--`, 3 AS [c/*;--]',
    query: 'SELECT 1 AS "a""/*;--", 2 AS `b``/*;--`, 3 AS [c/*;--]; -- end'
  },
  { expected: "SELECT $p::name(/*;')", query: "SELECT $p::name(/*;'); -- end" }
])('extracts exactly the first statement from $query', ({ expected, query }) => {
  const statement = extract(query)

  expect(statement).toBe(expected)
})

test.each([
  'SELECT 1 /* unterminated',
  'SELECT 1; /* unterminated',
  "SELECT '/*;--' /* unterminated",
  'SELECT 1; -- comment\r\nSELECT 2',
  'SELECT 1; -- comment\nSELECT 2',
  'SELECT 1; /* closed */ SELECT 2',
  'SELECT 1;;',
  'SELECT 1; /* closed */ ;',
  'SELECT 1;\0SELECT 2'
])('rejects invalid statement boundaries in %j', (query) => {
  const statement = extract(query)

  expect(statement).toBeUndefined()
})
