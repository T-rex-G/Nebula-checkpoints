'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const migrationPath = path.join(root, 'db', 'migrations', '006_github_app.sql');
assert(fs.existsSync(migrationPath), 'GitHub App migration must exist');
const sql = fs.readFileSync(migrationPath, 'utf8');
assert.match(sql, /CREATE TABLE IF NOT EXISTS nv_github_app_installations/i);
assert.match(sql, /identity_key\s+text\s+NOT NULL/i);
assert.match(sql, /installation_id\s+bigint\s+NOT NULL/i);
assert.match(sql, /PRIMARY KEY\s*\(identity_key,\s*installation_id\)/i);
assert.match(sql, /permissions\s+jsonb\s+NOT NULL/i);
assert.match(sql, /repository_selection\s+text\s+NOT NULL/i);
assert.match(sql, /status\s+text\s+NOT NULL/i);
assert.match(sql, /CREATE TABLE IF NOT EXISTS nv_github_app_audit/i);
assert.match(sql, /event_type\s+text\s+NOT NULL/i);
assert.match(sql, /details\s+jsonb\s+NOT NULL/i);
assert(!/token|private_key|client_secret/i.test(sql.replace(/installation_token_cache/gi, '')), 'migration must not persist credentials');
console.log('github app persistence contract tests passed');
