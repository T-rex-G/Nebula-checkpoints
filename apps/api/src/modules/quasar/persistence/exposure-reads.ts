import { RULE_NARRATION } from '../domain/exposure-narration.ts';
import type { Severity } from '../../../../../../packages/contracts/src/findings.ts';
import { type Row } from '../../../platform/persistence/queryable.ts';
import { fieldsOf, listOf, property, trimmedText } from '../../../platform/values/fields.ts';
import {
  boundedInteger, fail, requireScope, requireDigest, requireText, requireMember, rowsOf, scanOf, scanFromRow,
  findingFromRow, MAX_LIST_LIMIT, observationOf, dateOf, findingOf, DISPOSITIONS, findingsFilters, cursorSignature,
  decodeFindingsCursor, onlyRow, isRow, severityOf, observationFromRow, encodeFindingsCursor, decodeReportCursor,
  type Fields
} from './exposure-records.ts';
import type { ExposureStoreContext } from './exposure-records.ts';

/*
 * Reading what the store holds: a scan, a finding, a workspace's summary,
 * trend and findings, the lists a page is built from -- paged by signed
 * cursors -- and a scan's report. Every read is scoped to the repository and
 * the identity that asks.
 */

/*
 * Reads, and every one of them carries the identity boundary in the WHERE
 * clause rather than checking it afterwards. A scan id is a uuid somebody
 * could hold without owning, so "fetch then compare" is one forgotten
 * comparison away from being a cross-tenant read.
 */
export async function getScan(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const found = await store.query(
    `SELECT * FROM nv_exposure_scans WHERE scan_id=$1 AND identity_key=$2
       AND provider=$3 AND authority=$4 AND owner_login=$5 AND repo_name=$6`,
    [scanId, identityKey, scope.provider, scope.authority, scope.owner, scope.repo],
    'read a scan'
  );
  return scanFromRow(rowsOf(found)[0] || null);
}

export async function getFinding(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Finding identity');
  const fingerprint = requireDigest(input.fingerprint, 'Finding fingerprint');
  const found = await store.query(
    `SELECT * FROM nv_exposure_findings
      WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
        AND identity_key=$5 AND fingerprint=$6`,
    [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, fingerprint],
    'read a finding'
  );
  return findingFromRow(rowsOf(found)[0] || null);
}

/*
 * What the overview may say about every repository this person has scanned
 * at one provider: the newest finished scan of each, and the findings still
 * exposed under that scan's generation, counted by rule.
 *
 * "Still exposed" is `open` and `removed-from-tree`. The second is a
 * credential no longer in the tree but still in history, reachable from any
 * clone, and the findings screen deliberately never reads it as resolved --
 * so neither does the score. Counts and rule names only: no path, no
 * placeholder, nothing a repository chose.
 */
export async function workspaceSummary(store: ExposureStoreContext, input: Fields = {}) {
  const provider = requireText(input.provider, 'Scan provider', 40);
  const authority = requireText(input.authority, 'Scan authority', 255);
  const identityKey = requireDigest(input.identityKey, 'Summary identity');
  const found = await store.query(
    `WITH latest AS (
       SELECT DISTINCT ON (lower(owner_login), lower(repo_name))
              owner_login, repo_name, state, finished_at,
              rules_version, engine_version, fingerprint_key_version
         FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND identity_key=$3
          AND state IN ('complete', 'partial')
        ORDER BY lower(owner_login), lower(repo_name), finished_at DESC, scan_id DESC
        LIMIT $4)
     SELECT latest.owner_login AS owner, latest.repo_name AS repo,
            latest.state, latest.finished_at, finding.rule, count(finding.rule) AS open_count
       FROM latest
       LEFT JOIN nv_exposure_findings AS finding
         ON finding.provider=$1 AND finding.authority=$2 AND finding.identity_key=$3
        AND finding.owner_login=latest.owner_login AND finding.repo_name=latest.repo_name
        AND finding.disposition IN ('open', 'removed-from-tree')
        AND (finding.rules_version, finding.engine_version, finding.fingerprint_key_version)
          = (latest.rules_version, latest.engine_version, latest.fingerprint_key_version)
      GROUP BY latest.owner_login, latest.repo_name, latest.state, latest.finished_at, finding.rule
      ORDER BY latest.owner_login, latest.repo_name, finding.rule`,
    [provider, authority, identityKey, MAX_LIST_LIMIT * 5],
    'summarise the workspace'
  );
  return Object.freeze(rowsOf(found).map(row => Object.freeze({
    owner: row.owner,
    repo: row.repo,
    state: row.state,
    finishedAt: row.finished_at ? dateOf(row.finished_at).toISOString() : null,
    rule: row.rule || null,
    count: Number(row.open_count) || 0
  })));
}

/*
 * How the findings of each repository's latest scan arrived and settled,
 * as rolling seven-day windows ending at `now`, newest first. A finding
 * opened when a scan first observed it. It is fixed only once the
 * credential was proven rejected: removed from the tree is not fixed,
 * because the history still holds it. Accepted risks are counted as they
 * stand. The same latest scans, and the same version match, as the summary
 * above, so the two can never disagree about which findings exist.
 */
export async function workspaceTrend(store: ExposureStoreContext, input: Fields = {}) {
  const provider = requireText(input.provider, 'Scan provider', 40);
  const authority = requireText(input.authority, 'Scan authority', 255);
  const identityKey = requireDigest(input.identityKey, 'Summary identity');
  const asked = input.weeks;
  const weeks = typeof asked === 'number' && Number.isSafeInteger(asked) && asked >= 1 && asked <= 52 ? asked : 12;
  const now = new Date(typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()).toISOString();
  const found = await store.query(
    `WITH latest AS (
       SELECT DISTINCT ON (lower(owner_login), lower(repo_name))
              owner_login, repo_name, rules_version, engine_version, fingerprint_key_version
         FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND identity_key=$3
          AND state IN ('complete', 'partial')
        ORDER BY lower(owner_login), lower(repo_name), finished_at DESC, scan_id DESC
        LIMIT $4)
     SELECT finding.disposition,
            LEAST(floor(extract(epoch FROM $5::timestamptz - finding.first_observed_at) / 604800), $6)::integer AS opened_ago,
            CASE WHEN finding.disposition_at IS NULL THEN NULL
                 ELSE LEAST(floor(extract(epoch FROM $5::timestamptz - finding.disposition_at) / 604800), $6)::integer END AS settled_ago,
            count(*)::integer AS n
       FROM latest
       JOIN nv_exposure_findings AS finding
         ON finding.provider=$1 AND finding.authority=$2 AND finding.identity_key=$3
        AND finding.owner_login=latest.owner_login AND finding.repo_name=latest.repo_name
        AND (finding.rules_version, finding.engine_version, finding.fingerprint_key_version)
          = (latest.rules_version, latest.engine_version, latest.fingerprint_key_version)
      WHERE finding.first_observed_at <= $5::timestamptz
      GROUP BY 1, 2, 3`,
    [provider, authority, identityKey, MAX_LIST_LIMIT * 5, now, weeks],
    'summarise the workspace trend'
  );
  const opened = new Map<number, number>();
  const fixed = new Map<number, number>();
  let accepted = 0;
  for (const row of rowsOf(found)) {
    const count = Number(row.n) || 0;
    const openedAgo = Number(row.opened_ago);
    if (openedAgo >= 0 && openedAgo < weeks) opened.set(openedAgo, (opened.get(openedAgo) || 0) + count);
    if (row.disposition === 'accepted-risk') accepted += count;
    const settledAgo = row.settled_ago === null ? null : Number(row.settled_ago);
    if (row.disposition === 'credential-rejected' && settledAgo !== null && settledAgo >= 0 && settledAgo < weeks) {
      fixed.set(settledAgo, (fixed.get(settledAgo) || 0) + count);
    }
  }
  const series = (map: ReadonlyMap<number, number>) => Object.freeze([...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weeksAgo, count]) => Object.freeze({ weeksAgo, count })));
  return Object.freeze({ weeks, opened: series(opened), fixed: series(fixed), accepted });
}

/*
 * The findings inbox's leaked credentials: every finding of each
 * repository's newest finished scan, in the generation that scan used,
 * that is not over -- open, removed from the tree (still in history) or an
 * accepted risk. A credential its provider rejected is fixed and not listed.
 * The same latest scans as the summary, so the inbox and the Overview count
 * the same findings. Bounded, oldest first, with `truncated` when there were
 * more.
 */
export async function workspaceFindings(store: ExposureStoreContext, input: Fields = {}) {
  const provider = requireText(input.provider, 'Scan provider', 40);
  const authority = requireText(input.authority, 'Scan authority', 255);
  const identityKey = requireDigest(input.identityKey, 'Summary identity');
  const limit = boundedInteger(input.limit, 500, 1, 1000);
  const found = await store.query(
    `WITH latest AS (
       SELECT DISTINCT ON (lower(owner_login), lower(repo_name))
              owner_login, repo_name, rules_version, engine_version, fingerprint_key_version
         FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND identity_key=$3
          AND state IN ('complete', 'partial')
        ORDER BY lower(owner_login), lower(repo_name), finished_at DESC, scan_id DESC
        LIMIT $4)
     SELECT finding.* FROM latest
       JOIN nv_exposure_findings AS finding
         ON finding.provider=$1 AND finding.authority=$2 AND finding.identity_key=$3
        AND finding.owner_login=latest.owner_login AND finding.repo_name=latest.repo_name
        AND (finding.rules_version, finding.engine_version, finding.fingerprint_key_version)
          = (latest.rules_version, latest.engine_version, latest.fingerprint_key_version)
      WHERE finding.disposition IN ('open', 'removed-from-tree', 'accepted-risk')
      ORDER BY finding.first_observed_at, finding.owner_login, finding.repo_name, finding.fingerprint
      LIMIT $5`,
    [provider, authority, identityKey, MAX_LIST_LIMIT * 5, limit + 1],
    'list the workspace findings'
  );
  return Object.freeze({
    truncated: rowsOf(found).length > limit,
    findings: Object.freeze(rowsOf(found).slice(0, limit).map(row => findingOf(row)))
  });
}

export async function listFindings(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Finding identity');
  const limit = boundedInteger(input.limit, 50, 1, MAX_LIST_LIMIT);
  const dispositions = Array.isArray(input.dispositions) && input.dispositions.length
    ? input.dispositions.map(value => requireMember(value, DISPOSITIONS, 'Disposition'))
    : DISPOSITIONS.slice();
  /*
   * The current generation, when asked for -- as the findings screen does.
   * Every fingerprint moves with the rules, the
   * engine and the key, so a scan after an upgrade finds each credential
   * again under a new identity -- and listing both generations would show
   * every finding twice. The list follows this person's newest finished
   * scan of the repository; until one runs under the new rules, the old
   * findings are what there is and they stay on the screen.
   */
  const found = await store.query(
    `WITH generation AS (
       SELECT rules_version, engine_version, fingerprint_key_version FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5 AND state IN ('complete', 'partial')
        ORDER BY finished_at DESC, scan_id DESC
        LIMIT 1)
     SELECT finding.* FROM nv_exposure_findings AS finding
      WHERE finding.provider=$1 AND finding.authority=$2 AND finding.owner_login=$3 AND finding.repo_name=$4
        AND finding.identity_key=$5 AND finding.disposition = ANY($6::text[])
        AND (NOT $8::boolean OR NOT EXISTS (SELECT 1 FROM generation)
          OR (finding.rules_version, finding.engine_version, finding.fingerprint_key_version)
             = (SELECT rules_version, engine_version, fingerprint_key_version FROM generation))
      ORDER BY finding.first_observed_at, finding.fingerprint
      LIMIT $7`,
    [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, dispositions, limit,
      input.currentGeneration === true],
    'list findings'
  );
  return Object.freeze(rowsOf(found).map(row => findingOf(row)));
}

/* One statement sees a consistent generation, locations, counts and page.
   The signed cursor binds the viewer and filters. If evidence changes between
   pages we refuse a mixed report, instead of silently dropping or duplicating rows. */
export async function listFindingsPage(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Finding identity');
  const filters = findingsFilters(input);
  const limit = boundedInteger(input.limit, 50, 1, MAX_LIST_LIMIT);
  const binding = cursorSignature(JSON.stringify([scope, identityKey, filters, input.currentGeneration === true]), store.cursorKey);
  const cursor = input.cursor ? decodeFindingsCursor(input.cursor, store.cursorKey, binding) : null;
  if (cursor && Date.now() - Date.parse(cursor.snapshot) > 20 * 60 * 1000) {
    fail('This findings view expired. Refresh the findings and try again.', 'EXPOSURE_CURSOR_STALE', 409);
  }
  const severities: Readonly<Record<string, Severity>> = Object.fromEntries(Object.entries(RULE_NARRATION).map(([rule, entry]) => [rule, entry.severity]));
  const found = await store.query(
    `WITH generation AS (
       SELECT rules_version, engine_version, fingerprint_key_version, scan_id FROM nv_exposure_scans
        WHERE provider=$1 AND authority=$2 AND owner_login=$3 AND repo_name=$4
          AND identity_key=$5 AND state IN ('complete', 'partial')
        ORDER BY finished_at DESC, scan_id DESC LIMIT 1),
     base AS MATERIALIZED (
       SELECT f.*, location.observation,
              to_char(f.first_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
         FROM nv_exposure_findings f
         LEFT JOIN LATERAL (
           SELECT to_jsonb(o) AS observation FROM nv_exposure_observations o
             JOIN nv_exposure_scans s ON s.scan_id=o.scan_id
            WHERE o.fingerprint=f.fingerprint AND s.identity_key=$5
              AND s.provider=$1 AND s.authority=$2 AND s.owner_login=$3 AND s.repo_name=$4
            ORDER BY o.observed_at DESC, o.scan_id DESC LIMIT 1
         ) location ON true
        WHERE f.provider=$1 AND f.authority=$2 AND f.owner_login=$3 AND f.repo_name=$4 AND f.identity_key=$5
          AND (NOT $6::boolean OR NOT EXISTS (SELECT 1 FROM generation)
            OR (f.rules_version, f.engine_version, f.fingerprint_key_version) =
               (SELECT rules_version, engine_version, fingerprint_key_version FROM generation))),
     filtered AS MATERIALIZED (
       SELECT * FROM base b WHERE disposition = ANY($7::text[])
        AND ($8='all' OR COALESCE($9::jsonb->>rule, 'serious')=$8)
        AND ($10='all' OR ($10='tree' AND COALESCE((observation->>'in_tree')::boolean, true))
             OR ($10='history' AND (observation->>'in_tree')::boolean=false)
             OR ($10='archive' AND strpos(file_path, '!/')>0)
             OR ($10='encoded' AND observation->>'decoded_from'='base64'))
        AND NOT EXISTS (SELECT 1 FROM unnest($11::text[]) term
          WHERE strpos(lower(concat_ws(' ', file_path, rule, replace(rule, '-', ' '), placeholder,
            disposition, replace(disposition, '-', ' '), COALESCE($9::jsonb->>rule, 'serious'))), term)=0)),
     page AS (
       SELECT * FROM filtered WHERE ($12::timestamptz IS NULL OR
         (first_observed_at, fingerprint)>($12::timestamptz, $13::text))
       ORDER BY first_observed_at, fingerprint LIMIT $14)
     SELECT (SELECT count(*)::integer FROM filtered) AS total,
            (SELECT count(*)::integer FROM base) AS all_count,
            (SELECT jsonb_object_agg(rule, n) FROM (SELECT rule, count(*)::integer n FROM base GROUP BY rule) counts) AS by_rule,
            (SELECT jsonb_object_agg(disposition, n) FROM (SELECT disposition, count(*)::integer n FROM base GROUP BY disposition) counts) AS by_disposition,
            (SELECT jsonb_agg(to_jsonb(page) ORDER BY first_observed_at, fingerprint) FROM page) AS items,
            md5(COALESCE((SELECT string_agg(md5(to_jsonb(b)::text), '' ORDER BY fingerprint) FROM base b), '') ||
                COALESCE((SELECT scan_id::text FROM generation), '')) AS revision`,
    [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, input.currentGeneration === true,
      filters.dispositions, filters.severity, JSON.stringify(severities), filters.where,
      filters.query.split(' ').filter(Boolean), cursor ? cursor.at : null, cursor ? cursor.fingerprint : null, limit + 1],
    'page findings'
  );
  const row = onlyRow(found);
  if (cursor && cursor.revision !== row.revision) {
    fail('The findings changed while paging. Refresh to read one consistent view.', 'EXPOSURE_CURSOR_STALE', 409);
  }
  const items = listOf(row.items).filter(isRow);
  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  const byRule = fieldsOf(row.by_rule);
  const bySeverity: Record<Severity, number> = { critical: 0, serious: 0, warning: 0 };
  for (const [rule, count] of Object.entries(byRule)) bySeverity[severityOf(severities, rule)] += Number(count);
  return {
    findings: page.map(item => {
      const observation = observationFromRow(item.observation);
      return { ...findingOf(item), ...(observation ? {
        occurrences: observation.occurrences, occurrenceCount: observation.occurrenceCount,
        truncated: observation.truncated, inTree: observation.inTree,
        introducedCommit: observation.introducedCommit, introducedAt: observation.introducedAt,
        historyCommits: observation.historyCommits, decodedFrom: observation.decodedFrom
      } : {}) };
    }),
    total: row.total, counts: { all: row.all_count, byRule, bySeverity, byDisposition: row.by_disposition || {} },
    hasMore,
    nextCursor: hasMore ? encodeFindingsCursor({ version: 1, binding, revision: row.revision,
      snapshot: cursor ? cursor.snapshot : new Date().toISOString(), at: property(last, 'cursor_at'), fingerprint: property(last, 'fingerprint') }, store.cursorKey) : null
  };
}

export async function listObservations(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const limit = boundedInteger(input.limit, 50, 1, MAX_LIST_LIMIT);
  const found = await store.query(
    `SELECT observation.* FROM nv_exposure_observations AS observation
       JOIN nv_exposure_scans AS scan ON scan.scan_id=observation.scan_id
      WHERE observation.scan_id=$1 AND scan.identity_key=$2
        AND scan.provider=$4 AND scan.authority=$5 AND scan.owner_login=$6 AND scan.repo_name=$7
      ORDER BY observation.fingerprint
      LIMIT $3`,
    [scanId, identityKey, limit, scope.provider, scope.authority, scope.owner, scope.repo],
    'list observations'
  );
  return Object.freeze(rowsOf(found).map(row => observationOf(row)));
}

/*
 * The history: this identity's scans of this repository, newest first, each
 * with how many findings it recorded. A page at a time, continued from the
 * last row a caller saw rather than by offset, so a scan finishing while
 * somebody pages does not shift every later page by one.
 */
export async function listScans(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const limit = boundedInteger(input.limit, 20, 1, MAX_LIST_LIMIT);
  const before = input.before && typeof input.before === 'object' ? input.before : null;
  let cursorAt: Date | null = null;
  let cursorId: string | null = null;
  /*
   * A cursor arrives from a query string, so it is checked here rather than
   * handed to the database to reject: a malformed one is the caller's
   * mistake and says so, instead of surfacing as a server error.
   */
  if (before) {
    const at = Date.parse(trimmedText(property(before, 'createdAt')));
    const id = trimmedText(property(before, 'scanId')).toLowerCase();
    if (!Number.isFinite(at) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      fail('That history cursor is not valid', 'EXPOSURE_CURSOR_INVALID', 400);
    }
    cursorAt = new Date(at);
    cursorId = id;
  }
  const found = await store.query(
    `SELECT scan.*,
            (SELECT count(*) FROM nv_exposure_observations AS observation
              WHERE observation.scan_id = scan.scan_id)::integer AS finding_count
       FROM nv_exposure_scans AS scan
      WHERE scan.provider=$1 AND scan.authority=$2 AND scan.owner_login=$3 AND scan.repo_name=$4
        AND scan.identity_key=$5
        AND ($6::timestamptz IS NULL OR (scan.created_at, scan.scan_id) < ($6::timestamptz, $7::uuid))
      ORDER BY scan.created_at DESC, scan.scan_id DESC
      LIMIT $8`,
    [scope.provider, scope.authority, scope.owner, scope.repo, identityKey, cursorAt, cursorId, limit],
    'list scans'
  );
  return Object.freeze(rowsOf(found).map(row => Object.freeze({
    ...scanOf(row),
    findingCount: Number(row.finding_count) || 0
  })));
}

/*
 * How many findings of each rule a page of scans recorded, in one query, so
 * a history row can say "2 critical, 1 serious" without the reader opening
 * it. Rules rather than severities: severity is the narration table's, and
 * this file does not keep a second copy of it.
 */
export async function scanRuleCounts(store: ExposureStoreContext, input: Fields = {}) {
  const scope = requireScope(input.scope);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const scanIds = [...new Set((Array.isArray(input.scanIds) ? input.scanIds : [])
    .map(value => trimmedText(value))
    .filter(value => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, MAX_LIST_LIMIT);
  if (!scanIds.length) return Object.freeze([]);
  const found = await store.query(
    `SELECT observation.scan_id, finding.rule, count(*)::integer AS total
       FROM nv_exposure_observations AS observation
       JOIN nv_exposure_scans AS scan ON scan.scan_id = observation.scan_id
       JOIN nv_exposure_findings AS finding
         ON finding.provider = scan.provider AND finding.authority = scan.authority
        AND finding.owner_login = scan.owner_login AND finding.repo_name = scan.repo_name
        AND finding.fingerprint = observation.fingerprint AND finding.identity_key = scan.identity_key
      WHERE observation.scan_id = ANY($1::uuid[]) AND scan.identity_key=$2
        AND scan.provider=$3 AND scan.authority=$4 AND scan.owner_login=$5 AND scan.repo_name=$6
      GROUP BY observation.scan_id, finding.rule`,
    [scanIds, identityKey, scope.provider, scope.authority, scope.owner, scope.repo],
    'count findings by rule'
  );
  return Object.freeze(rowsOf(found).map(row => Object.freeze({
    scanId: row.scan_id, rule: row.rule, total: Number(row.total) || 0
  })));
}

/*
 * One scan's report: what it observed, each with the finding it is about.
 * The observation says where and how many times in that scan; the finding
 * says what the credential is and what has since been decided about it.
 * Joined on the scan's own identity, so a report can never show somebody
 * else's copy of a finding.
 */
export async function scanReport(store: ExposureStoreContext, input: Fields = {}) {
  return (await readScanReport(store, input, false)).observations;
}

export async function scanReportPage(store: ExposureStoreContext, input: Fields = {}) {
  return readScanReport(store, input, true);
}

export async function readScanReport(store: ExposureStoreContext, input: Fields, paged: boolean) {
  const scope = requireScope(input.scope);
  const scanId = requireText(input.scanId, 'Scan id', 64);
  const identityKey = requireDigest(input.identityKey, 'Scan identity');
  const limit = boundedInteger(input.limit, 50, 1, MAX_LIST_LIMIT);
  const binding = cursorSignature(JSON.stringify(['scan-report', scope, identityKey, scanId]), store.cursorKey);
  const cursor = paged && input.cursor ? decodeReportCursor(input.cursor, store.cursorKey, binding) : null;
  const query = `SELECT observation.*,
            finding.provider AS finding_provider, finding.authority AS finding_authority,
            finding.owner_login AS finding_owner_login, finding.repo_name AS finding_repo_name,
            finding.fingerprint AS finding_fingerprint,
            finding.fingerprint_key_version, finding.rules_version, finding.engine_version,
            finding.rule, finding.file_path, finding.placeholder, finding.disposition,
            finding.disposition_at, finding.disposition_by, finding.first_observed_at,
            finding.last_observed_at,
            CASE WHEN observation.in_tree IS FALSE THEN observation.introduced_commit
                 ELSE scan.commit_sha END AS commit_sha
       FROM nv_exposure_observations AS observation
       JOIN nv_exposure_scans AS scan ON scan.scan_id = observation.scan_id
       JOIN nv_exposure_findings AS finding
         ON finding.provider = scan.provider AND finding.authority = scan.authority
        AND finding.owner_login = scan.owner_login AND finding.repo_name = scan.repo_name
        AND finding.fingerprint = observation.fingerprint AND finding.identity_key = scan.identity_key
      WHERE observation.scan_id=$1 AND scan.identity_key=$2
        AND scan.provider=$3 AND scan.authority=$4 AND scan.owner_login=$5 AND scan.repo_name=$6
      `;
  const parameters: unknown[] = [scanId, identityKey, scope.provider, scope.authority, scope.owner, scope.repo, paged ? limit + 1 : limit];
  if (paged) parameters.push(cursor ? cursor.fingerprint : '');
  const found = await store.query(paged
    ? `WITH report AS MATERIALIZED (${query})
       SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY finding_fingerprint)
                 FROM (SELECT * FROM report WHERE finding_fingerprint > $8 ORDER BY finding_fingerprint LIMIT $7) p) AS items,
              (SELECT md5(COALESCE(string_agg((to_jsonb(r) - 'last_observed_at')::text, '' ORDER BY finding_fingerprint), ''))
                 FROM report r) AS revision`
    : `${query} ORDER BY finding.file_path, finding.rule, observation.fingerprint LIMIT $7`,
    parameters, 'read a scan report'
  );
  /*
   * The revision covers what this report says, decisions included. Last seen
   * is left out: every newer scan of the repository moves it on shared
   * findings, and a finished scan's report must still page to the end.
   */
  const revision = paged ? onlyRow(found).revision : null;
  if (cursor && cursor.revision !== revision) {
    fail('This scan report changed while paging. Refresh the report.', 'EXPOSURE_CURSOR_STALE', 409);
  }
  const rows: readonly Row[] = paged ? listOf(onlyRow(found).items).filter(isRow) : rowsOf(found);
  const hasMore = paged && rows.length > limit;
  const observations = Object.freeze(rows.slice(0, limit).map(row => Object.freeze({
    observation: observationOf(row),
    /* Named column by column, like every other row that leaves here. */
    finding: findingFromRow({
      provider: row.finding_provider,
      authority: row.finding_authority,
      owner_login: row.finding_owner_login,
      repo_name: row.finding_repo_name,
      fingerprint: row.finding_fingerprint,
      fingerprint_key_version: row.fingerprint_key_version,
      rules_version: row.rules_version,
      engine_version: row.engine_version,
      rule: row.rule,
      file_path: row.file_path,
      commit_sha: row.commit_sha,
      placeholder: row.placeholder,
      disposition: row.disposition,
      disposition_at: row.disposition_at,
      disposition_by: row.disposition_by,
      first_observed_at: row.first_observed_at,
      last_observed_at: row.last_observed_at
    })
  })));
  const lastSeen = observations[observations.length - 1];
  return Object.freeze({ observations, complete: !hasMore,
    nextCursor: hasMore ? encodeFindingsCursor({ version: 1, binding, revision,
      snapshot: cursor ? cursor.snapshot : new Date().toISOString(),
      fingerprint: lastSeen && lastSeen.observation.fingerprint }, store.cursorKey) : null });
}
