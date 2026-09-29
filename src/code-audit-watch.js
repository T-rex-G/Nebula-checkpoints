'use strict';

/*
 * The watch: what has been published about a repository's dependencies since
 * it was last audited.
 *
 * An audit is a photograph. The day after it, a new advisory can be published
 * for a package version the repository still ships, or CISA can add a CVE the
 * audit already reported to its catalog of vulnerabilities exploited in the
 * wild -- and the grade on the screen says nothing about either until
 * somebody audits again. The watch asks the same two public sources the audit
 * asked, about the components the audit stored, and reports only the
 * difference:
 *
 *   - `advisory`: an OSV advisory for a stored package version whose id the
 *     audit did not receive, and which is not an alias of one it did.
 *   - `exploited`: a CVE the audit reported, which the catalog did not list
 *     then and lists now.
 *
 * It needs no repository access and no credential: names, versions and CVE
 * identifiers leave, anonymously, through the guarded transport's advisory and
 * threat-intel profiles, exactly as they do during an audit. A source that
 * cannot be reached leaves the watch partial or unavailable -- never "nothing
 * new", which is a claim that needs an answer behind it.
 */

const audit = require('./code-audit');
const { lookupExploitIntel } = require('./exploit-intel');

const LIMITS = Object.freeze({
  ...audit.LIMITS,
  /* New advisories whose records are fetched. Past this they are reported by id, unrated. */
  maxAdvisoryDetails: 60,
  maxAlerts: 100
});

const SEVERITY_RANK = Object.freeze({ critical: 0, serious: 1, warning: 2 });
const idRank = id => (id.startsWith('MAL-') ? 0 : id.startsWith('GHSA-') ? 1 : 2);

function exploitFacts(answer) {
  if (!answer) return { exploited: false, ransomware: false, kevAdded: null, kevDue: null, epss: null };
  return {
    exploited: Boolean(answer.kev),
    ransomware: Boolean(answer.kev && answer.kev.ransomware),
    kevAdded: answer.kev ? answer.kev.added || null : null,
    kevDue: answer.kev ? answer.kev.due || null : null,
    epss: Number.isFinite(answer.epss) ? answer.epss : null
  };
}

function order(a, b) {
  return Number(b.exploited) - Number(a.exploited)
    || Number(Boolean(b.malicious)) - Number(Boolean(a.malicious))
    || (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
    || Number(b.direct) - Number(a.direct)
    || `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
    || String(a.id || a.cve).localeCompare(String(b.id || b.cve));
}

/*
 * `components` are what the audit stored: ecosystem, name, version, direct,
 * dev and the baseline -- the advisory ids, CVEs and catalog-listed CVEs the
 * audit knew about for that version.
 */
async function watchComponents({ components, advisoryTransport, intelTransport, intelCache, limits = LIMITS }) {
  const entries = (Array.isArray(components) ? components : []).filter(component => component && component.name && component.version);
  const baseline = new Map(entries.map(component => [audit.advisoryKey(component), component]));
  const queried = await audit.queryAdvisoryIds(entries, advisoryTransport, limits);
  const answered = queried.asked.filter(entry => !queried.unknown.has(audit.advisoryKey(entry)));

  /* Ids OSV holds now that the audit did not receive, per version. */
  const fresh = [];
  for (const entry of answered) {
    const key = audit.advisoryKey(entry);
    const known = new Set((baseline.get(key).advisoryIds || []).map(String));
    for (const id of queried.ids.get(key) || []) if (!known.has(id)) fresh.push({ entry, id });
  }
  const wanted = [...new Set(fresh.sort((a, b) => Number(b.entry.direct) - Number(a.entry.direct) || idRank(a.id) - idRank(b.id)).map(item => item.id))];
  const records = fresh.length ? await audit.fetchAdvisoryRecords(wanted, advisoryTransport, limits) : new Map();

  const alerts = [];
  const covered = new Map();
  for (const { entry, id } of fresh) {
    const key = audit.advisoryKey(entry);
    const known = new Set((baseline.get(key).advisoryIds || []).map(String));
    const seen = covered.get(key) || new Set();
    covered.set(key, seen);
    if (seen.has(id)) continue;
    const record = records.get(id);
    const aliases = record && Array.isArray(record.aliases) ? record.aliases.map(String) : [];
    /* A new record for a vulnerability the audit already reported under another id is not news. */
    if (aliases.some(alias => known.has(alias))) continue;
    aliases.forEach(alias => seen.add(alias));
    seen.add(id);
    const advisory = audit.describeAdvisory(id, record, entry);
    const cves = new Set((baseline.get(key).cves || []).map(String));
    if (advisory.cve && cves.has(advisory.cve)) continue;
    alerts.push({
      kind: 'advisory', ecosystem: entry.ecosystem, name: entry.name, version: entry.version,
      direct: Boolean(entry.direct), dev: Boolean(entry.dev),
      id, cve: advisory.cve, severity: advisory.severity, cvss: advisory.cvss, fixed: advisory.fixed, malicious: advisory.malicious
    });
  }

  /*
   * The catalog, asked about every CVE the audit reported that it did not
   * list then, and every CVE a new advisory carries.
   */
  const pending = new Map();
  for (const entry of entries) {
    const listed = new Set((entry.exploitedCves || []).map(String));
    for (const cve of entry.cves || []) if (!listed.has(cve)) pending.set(`${audit.advisoryKey(entry)}\0${cve}`, { entry, cve });
  }
  const askCves = [...new Set([...[...pending.values()].map(item => item.cve), ...alerts.map(alert => alert.cve).filter(Boolean)])];
  const intel = intelTransport && askCves.length
    ? await lookupExploitIntel(askCves, intelTransport, intelCache ? { cache: intelCache } : {})
    : { answers: new Map(), status: { kev: askCves.length ? 'unavailable' : 'not-needed', kevVersion: null } };

  for (const alert of alerts) Object.assign(alert, exploitFacts(alert.cve ? intel.answers.get(alert.cve) : null));
  for (const { entry, cve } of pending.values()) {
    const facts = exploitFacts(intel.answers.get(cve));
    if (!facts.exploited) continue;
    alerts.push({
      kind: 'exploited', ecosystem: entry.ecosystem, name: entry.name, version: entry.version,
      direct: Boolean(entry.direct), dev: Boolean(entry.dev),
      id: null, cve, severity: null, cvss: null, fixed: null, malicious: false, ...facts
    });
  }

  const total = entries.length;
  const checked = answered.length;
  const state = !total ? 'ok' : checked === 0 ? 'unavailable' : checked < total ? 'partial' : 'ok';
  return {
    state,
    checked,
    total,
    kev: intel.status.kev,
    kevVersion: intel.status.kevVersion || null,
    alerts: alerts.sort(order).slice(0, limits.maxAlerts),
    truncated: Math.max(0, alerts.length - limits.maxAlerts)
  };
}

module.exports = Object.freeze({ watchComponents, LIMITS });
