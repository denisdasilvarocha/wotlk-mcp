import { constants } from 'node:sqlite'

import type { DatabaseSync } from 'node:sqlite'

const pragmas = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'foreign_key_list'
])

const actions = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE
])

export function installSqlAuthorizer(db: DatabaseSync): <T>(execute: () => T) => T {
  let executing = false

  db.setAuthorizer((action, name, argument, schema, context) => {
    if (action === constants.SQLITE_READ && name?.toLowerCase() === 'pragma_data_version') {
      return constants.SQLITE_DENY
    }
    if (actions.has(action)) {
      return constants.SQLITE_OK
    }
    if (action === constants.SQLITE_PRAGMA) {
      if (name !== null && pragmas.has(name.toLowerCase())) {
        return constants.SQLITE_OK
      }
      if (
        executing &&
        name === 'data_version' &&
        argument === null &&
        schema === 'main' &&
        context === null
      ) {
        return constants.SQLITE_OK
      }
    }

    return constants.SQLITE_DENY
  })

  return (execute) => {
    executing = true
    try {
      return execute()
    } finally {
      executing = false
    }
  }
}
