/*
 * The bill of materials, in the two formats supply-chain tools read:
 * CycloneDX 1.5 and SPDX 2.3. Every component the manifests and lockfiles
 * name, by package URL, with its licence where the lockfile states one, what
 * it depends on, and -- in CycloneDX -- the vulnerabilities this audit found
 * against it with their exploit intelligence and reach. Names, versions and
 * licences only, read from the result as it arrived; never a line of the
 * code.
 */
import { field, items } from '../../platform/values.ts';
import { at, entry, finite, text } from './audit-terms.ts';

const SPDX_EXPRESSION = /^\(?[A-Za-z0-9][A-Za-z0-9.+-]*(\s+(AND|OR|WITH)\s+\(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?)*\)?$/;
/* A random identifier for a document; the browser's own where it has one. */
function uuid(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function licencesOf(component: unknown): string[] {
  const licence = field(component, 'license');
  return (Array.isArray(licence) ? items(licence) : licence ? [licence] : []).map(value => String(value).trim()).filter(Boolean);
}
/* CycloneDX and SPDX split a coordinate into a group and a name where the ecosystem has one. */
function coordinates(component: unknown): { readonly group: string | null; readonly name: string } {
  const name = String(field(component, 'name'));
  const ecosystem = field(component, 'ecosystem');
  if (ecosystem === 'maven' && name.includes(':')) return { group: name.split(':')[0] ?? '', name: name.split(':')[1] ?? '' };
  if ((ecosystem === 'npm' && name.startsWith('@')) || ecosystem === 'packagist') {
    const slash = name.indexOf('/');
    if (slash > 0) return { group: name.slice(0, slash), name: name.slice(slash + 1) };
  }
  return { group: null, name };
}
const CDX_SEVERITY: Readonly<Record<string, string>> = Object.freeze({ critical: 'critical', serious: 'high', warning: 'medium' });
const dependencyFindings = (result: unknown): readonly unknown[] =>
  items(field(result, 'findings')).filter(finding => at(finding, 'detail', 'purl') && Array.isArray(at(finding, 'detail', 'advisories')));
const listedComponents = (result: unknown): readonly unknown[] => items(field(result, 'components'));

export function cyclonedx(result: unknown, meta: unknown = {}): string {
  const components = listedComponents(result);
  const refs = new Set(components.map(component => field(component, 'purl')).filter(Boolean));
  const engineVersion = at(result, 'engine', 'version');
  const property = (name: string, value: unknown): { readonly name: string; readonly value: string } => ({ name: `nebulaverse:${name}`, value: String(value) });
  const bomComponents = components.filter(component => field(component, 'purl')).map(component => {
    const { group, name } = coordinates(component);
    const licences = licencesOf(component);
    const only = licences.length === 1 ? licences[0] ?? '' : '';
    const licenses = only && /\s(AND|OR|WITH)\s/.test(only)
      ? [{ expression: only }]
      : licences.map(value => (SPDX_EXPRESSION.test(value) && !/\s/.test(value) ? { license: { id: value } } : { license: { name: value } }));
    const path = field(component, 'path');
    return {
      type: 'library', 'bom-ref': field(component, 'purl'), ...(group ? { group } : {}), name, version: field(component, 'version'), purl: field(component, 'purl'),
      scope: field(component, 'dev') ? 'optional' : 'required',
      ...(licenses.length ? { licenses } : {}),
      properties: [property('ecosystem', field(component, 'ecosystem')), property('direct', Boolean(field(component, 'direct'))), property('source', field(component, 'source')), ...(path ? [property('declared-in', path)] : [])]
    };
  });
  /* One vulnerability per advisory, affecting every component it was found in. */
  const vulnerabilities = new Map<unknown, { readonly affects: { readonly ref: unknown }[]; readonly [key: string]: unknown }>();
  for (const finding of dependencyFindings(result)) {
    const detail = field(finding, 'detail');
    const purl = field(detail, 'purl');
    if (!refs.has(purl)) continue;
    for (const advisory of items(field(detail, 'advisories'))) {
      const id = field(advisory, 'id');
      const known = vulnerabilities.get(id);
      if (known) {
        if (!known.affects.some(item => item.ref === purl)) known.affects.push({ ref: purl });
        continue;
      }
      const intel = field(detail, 'intel') || null;
      const risk = field(detail, 'risk');
      const usage = field(detail, 'usage');
      const cve = field(advisory, 'cve');
      const cvss = finite(field(advisory, 'cvss'));
      const properties: { readonly name: string; readonly value: string }[] = [];
      const epss = finite(field(advisory, 'epss'));
      if (epss !== null) properties.push(property('epss', epss));
      if (field(advisory, 'kev')) properties.push(property('cisa-kev', true));
      if (intel && field(intel, 'ransomware') && field(intel, 'kev') && at(intel, 'kev', 'cve') === cve) properties.push(property('ransomware', true));
      if (risk) properties.push(property('risk', field(risk, 'score')), property('risk-band', field(risk, 'band')));
      if (usage) properties.push(property('reach', field(usage, 'tier')));
      const fixed = field(detail, 'fixed');
      vulnerabilities.set(id, {
        'bom-ref': `vuln:${text(id)}`,
        id,
        source: { name: 'OSV', url: `https://osv.dev/vulnerability/${encodeURIComponent(text(id))}` },
        ...(cve ? { references: [{ id: cve, source: { name: 'NVD', url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(text(cve))}` } }] } : {}),
        ratings: [{ source: { name: 'OSV' }, ...(cvss !== null ? { score: cvss, method: 'CVSSv3' } : {}), severity: entry(CDX_SEVERITY, field(advisory, 'severity')) ?? 'unknown' }],
        ...(field(advisory, 'summary') ? { description: field(advisory, 'summary') } : {}),
        ...(fixed && field(finding, 'rule') !== 'DEP-006' ? { recommendation: `Upgrade ${text(field(detail, 'package'))} to ${text(fixed)} or later.` } : {}),
        affects: [{ ref: purl }],
        ...(properties.length ? { properties } : {})
      });
    }
  }
  const commitSha = field(result, 'commitSha');
  const root = { type: 'application', 'bom-ref': 'root', name: field(meta, 'name') || 'repository', ...(commitSha ? { version: commitSha } : {}) };
  const dependencies = [
    { ref: 'root', dependsOn: components.filter(component => field(component, 'direct') && field(component, 'purl')).map(component => field(component, 'purl')) },
    ...components.filter(component => field(component, 'purl') && items(field(component, 'dependsOn')).length)
      .map(component => ({ ref: field(component, 'purl'), dependsOn: items(field(component, 'dependsOn')).filter(target => refs.has(target)) }))
  ];
  const truncated = field(result, 'componentsTruncated');
  const ref = field(meta, 'ref');
  return JSON.stringify({
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${uuid()}`, version: 1,
    metadata: {
      timestamp: field(result, 'auditedAt') || new Date().toISOString(),
      tools: { components: [{ type: 'application', name: 'Nebulaverse-X Uranus', ...(engineVersion ? { version: engineVersion } : {}) }] },
      component: root,
      properties: [...(ref ? [property('ref', ref)] : []), ...(truncated ? [property('components-truncated', truncated)] : [])]
    },
    components: bomComponents,
    dependencies,
    vulnerabilities: [...vulnerabilities.values()]
  }, null, 2);
}

export function spdx(result: unknown, meta: unknown = {}): string {
  const components = listedComponents(result).filter(component => field(component, 'purl'));
  const engineVersion = text(at(result, 'engine', 'version'));
  const id = new Map(components.map((component, index) => [field(component, 'purl'), `SPDXRef-Package-${index + 1}`]));
  const advisoriesByPurl = new Map<unknown, unknown[]>();
  for (const finding of dependencyFindings(result)) {
    const purl = at(finding, 'detail', 'purl');
    const list = advisoriesByPurl.get(purl) ?? [];
    for (const advisory of items(at(finding, 'detail', 'advisories'))) {
      const advisoryId = field(advisory, 'id');
      if (!list.includes(advisoryId)) list.push(advisoryId);
    }
    advisoriesByPurl.set(purl, list);
  }
  const declared = (component: unknown): string => {
    const licences = licencesOf(component);
    const expression = licences.length > 1 ? licences.map(value => (/\s/.test(value) ? `(${value})` : value)).join(' AND ') : licences[0];
    return expression && SPDX_EXPRESSION.test(expression.replace(/[()]/g, '')) ? expression : 'NOASSERTION';
  };
  const name = field(meta, 'name');
  const packages = [
    {
      name: name || 'repository', SPDXID: 'SPDXRef-Root', versionInfo: field(result, 'commitSha') || 'NOASSERTION', downloadLocation: field(meta, 'repositoryUri') || 'NOASSERTION',
      filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', primaryPackagePurpose: 'APPLICATION'
    },
    ...components.map(component => ({
      name: field(component, 'name'), SPDXID: id.get(field(component, 'purl')), versionInfo: field(component, 'version'), downloadLocation: 'NOASSERTION',
      filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: declared(component), copyrightText: 'NOASSERTION', primaryPackagePurpose: 'LIBRARY',
      externalRefs: [
        { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: field(component, 'purl') },
        ...(advisoriesByPurl.get(field(component, 'purl')) ?? []).map(advisory => ({ referenceCategory: 'SECURITY', referenceType: 'advisory', referenceLocator: `https://osv.dev/vulnerability/${encodeURIComponent(text(advisory))}` }))
      ]
    }))
  ];
  const relationships = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Root' }];
  for (const component of components) {
    const self = text(id.get(field(component, 'purl')));
    if (field(component, 'direct')) {
      relationships.push(field(component, 'dev')
        ? { spdxElementId: self, relationshipType: 'DEV_DEPENDENCY_OF', relatedSpdxElement: 'SPDXRef-Root' }
        : { spdxElementId: 'SPDXRef-Root', relationshipType: 'DEPENDS_ON', relatedSpdxElement: self });
    }
    for (const target of items(field(component, 'dependsOn'))) {
      const other = id.get(target);
      if (other) relationships.push({ spdxElementId: self, relationshipType: 'DEPENDS_ON', relatedSpdxElement: other });
    }
  }
  const slug = String(name || 'repository').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
  return JSON.stringify({
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: `${text(name) || 'repository'} dependencies`,
    documentNamespace: `https://spdx.org/spdxdocs/${slug}-${uuid()}`,
    creationInfo: { created: String(field(result, 'auditedAt') || new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z'), creators: [`Tool: Nebulaverse-X-Uranus${engineVersion ? `-${engineVersion}` : ''}`] },
    packages, relationships
  }, null, 2);
}
