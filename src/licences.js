'use strict';

/*
 * Licences: what each dependency may be used under, and whether that sits
 * with what the project is released under and with what its owners allow.
 *
 * A dependency's licence is read where its lockfile states one (npm and
 * Composer record one per package) and otherwise asked of deps.dev by
 * ecosystem, name and version -- anonymously, through the guarded
 * transport's licence profile, which reaches that one host and nothing else.
 * Nothing about the repository leaves but the names and versions it depends
 * on, as with the advisory lookup. A licence that was not answered is
 * unknown, and unknown is reported only for a package the project asked for
 * itself.
 *
 * Licences are compliance, not security. Their findings are a family of
 * their own, reported and exported with the rest, but they carry no weight
 * in the grade and never enter what to fix first.
 */

/* Run an operation over values, at most `limit` at a time. */
async function boundedMapLimit(values, limit, operation) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await operation(values[index], index);
    }
  });
  await Promise.all(workers);
}

/* ---- Families ------------------------------------------------------------------ */

/*
 * What a licence asks of the software that uses it, in the order of how much
 * it asks: nothing; notice; share changes to the licensed files; share the
 * whole work when it is distributed; share it even when it is only offered
 * over a network; or a limit on use itself (no commercial use, no competing
 * service). "None" is a package that grants no licence at all; "unknown" is
 * one whose licence could not be read.
 */
const FAMILIES = Object.freeze([
  Object.freeze({ id: 'public-domain', label: 'Public domain', rank: 0 }),
  Object.freeze({ id: 'permissive', label: 'Permissive', rank: 1 }),
  Object.freeze({ id: 'weak-copyleft', label: 'Weak copyleft', rank: 2 }),
  Object.freeze({ id: 'strong-copyleft', label: 'Strong copyleft', rank: 3 }),
  Object.freeze({ id: 'network-copyleft', label: 'Network copyleft', rank: 4 }),
  Object.freeze({ id: 'restricted', label: 'Restricted use', rank: 5 }),
  Object.freeze({ id: 'none', label: 'No licence granted', rank: 6 }),
  Object.freeze({ id: 'unknown', label: 'Unknown', rank: 7 })
]);
const RANK = Object.freeze(Object.fromEntries(FAMILIES.map(family => [family.id, family.rank])));
const FAMILY_IDS = new Set(FAMILIES.map(family => family.id));

const KNOWN = new Map();
function known(family, ids) {
  for (const id of ids) KNOWN.set(id.toLowerCase(), Object.freeze({ id, family }));
}
known('public-domain', ['CC0-1.0', 'Unlicense', '0BSD', 'WTFPL', 'MIT-0', 'PDDL-1.0', 'CC-PDDC']);
known('permissive', [
  'MIT', 'MIT-CMU', 'MIT-Modern-Variant', 'X11', 'Apache-1.0', 'Apache-1.1', 'Apache-2.0', 'BSD-1-Clause', 'BSD-2-Clause',
  'BSD-2-Clause-Patent', 'BSD-3-Clause', 'BSD-3-Clause-Clear', 'BSD-3-Clause-LBNL', 'BSD-4-Clause', 'BSD-Source-Code', 'ISC',
  'Zlib', 'zlib-acknowledgement', 'BSL-1.0', 'PSF-2.0', 'Python-2.0', 'Python-2.0.1', 'Artistic-2.0', 'PostgreSQL', 'OpenSSL',
  'SSLeay-standalone', 'CC-BY-3.0', 'CC-BY-4.0', 'Unicode-DFS-2015', 'Unicode-DFS-2016', 'Unicode-3.0', 'BlueOak-1.0.0',
  'NCSA', 'UPL-1.0', 'AFL-2.1', 'AFL-3.0', 'Ruby', 'W3C', 'W3C-20150513', 'curl', 'libpng-2.0', 'Libpng', 'ICU', 'HPND',
  'MulanPSL-2.0', 'ECL-2.0', 'Beerware', 'OFL-1.1', 'ZPL-2.0', 'ZPL-2.1', 'IJG', 'bzip2-1.0.6', 'Info-ZIP', 'Vim', 'MS-PL',
  'NTP', 'FSFAP', 'FSFUL', 'FSFULLR', 'Xnet', 'Naumen', 'TCL', 'X11-distribute-modifications-variant', 'OLDAP-2.8',
  'EFL-2.0', 'Fair', 'MirOS', 'Unicode-TOU', 'CNRI-Python', 'Intel', 'AAL', 'AMPAS', 'Spencer-94', 'Qhull', 'Jam', 'SMLNJ'
]);
known('weak-copyleft', [
  'LGPL-2.0-only', 'LGPL-2.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'LGPLLR',
  'MPL-1.0', 'MPL-1.1', 'MPL-2.0', 'MPL-2.0-no-copyleft-exception', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1', 'CPL-1.0',
  'IPL-1.0', 'MS-RL', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'Artistic-1.0', 'Artistic-1.0-Perl', 'ErlPL-1.1', 'APSL-2.0',
  'CECILL-C', 'CECILL-B', 'OFL-1.0', 'SPL-1.0', 'NPL-1.1', 'Motosoto', 'LiLiQ-R-1.1', 'CUA-OPL-1.0'
]);
known('strong-copyleft', [
  'GPL-1.0-only', 'GPL-1.0-or-later', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'EUPL-1.0', 'EUPL-1.1', 'EUPL-1.2', 'Sleepycat', 'CECILL-2.0', 'CECILL-2.1', 'QPL-1.0', 'ODbL-1.0', 'CC-BY-SA-2.0',
  'LiLiQ-Rplus-1.1', 'CPOL-1.02'
]);
known('network-copyleft', [
  'AGPL-1.0-only', 'AGPL-1.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'SSPL-1.0', 'OSL-1.0', 'OSL-1.1',
  'OSL-2.0', 'OSL-2.1', 'OSL-3.0', 'RPL-1.1', 'RPL-1.5', 'CPAL-1.0', 'Watcom-1.0'
]);
known('restricted', [
  'BUSL-1.1', 'Elastic-2.0', 'JSON', 'PolyForm-Noncommercial-1.0.0', 'PolyForm-Small-Business-1.0.0', 'Commons-Clause',
  'Hippocratic-2.1', 'CC-BY-NC-1.0', 'CC-BY-NC-2.0', 'CC-BY-NC-2.5', 'CC-BY-NC-3.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-2.0',
  'CC-BY-NC-SA-2.5', 'CC-BY-NC-SA-3.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-3.0', 'CC-BY-NC-ND-4.0', 'CC-BY-ND-3.0',
  'CC-BY-ND-4.0', 'SSPL', 'Confluent-Community-1.0', 'Prosperity-3.0.0', 'Parity-7.0.0'
]);

/* The GNU identifiers SPDX retired, and what each meant. */
const DEPRECATED = new Map(Object.entries({
  'gpl-1.0': 'GPL-1.0-only', 'gpl-1.0+': 'GPL-1.0-or-later', 'gpl-2.0': 'GPL-2.0-only', 'gpl-2.0+': 'GPL-2.0-or-later',
  'gpl-3.0': 'GPL-3.0-only', 'gpl-3.0+': 'GPL-3.0-or-later', 'lgpl-2.0': 'LGPL-2.0-only', 'lgpl-2.0+': 'LGPL-2.0-or-later',
  'lgpl-2.1': 'LGPL-2.1-only', 'lgpl-2.1+': 'LGPL-2.1-or-later', 'lgpl-3.0': 'LGPL-3.0-only', 'lgpl-3.0+': 'LGPL-3.0-or-later',
  'agpl-1.0': 'AGPL-1.0-only', 'agpl-3.0': 'AGPL-3.0-only', 'agpl-3.0+': 'AGPL-3.0-or-later'
}));

/*
 * What people write in a manifest instead of an identifier. Only names with
 * one reading are here: a bare "GPL" is strong copyleft whatever its version,
 * so it resolves to the family without pretending to know which.
 */
const ALIASES = new Map(Object.entries({
  'mit license': 'MIT', 'the mit license': 'MIT', 'mit/x11': 'MIT', expat: 'MIT', 'mit licence': 'MIT',
  'apache 2': 'Apache-2.0', 'apache 2.0': 'Apache-2.0', 'apache-2': 'Apache-2.0', apache2: 'Apache-2.0', 'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0', 'apache license version 2.0': 'Apache-2.0', 'apache software license': 'Apache-2.0',
  'asl 2.0': 'Apache-2.0', 'apache license': 'Apache-2.0', 'apache software license 2.0': 'Apache-2.0', 'apache 2 license': 'Apache-2.0',
  'bsd license': 'BSD-3-Clause', 'new bsd': 'BSD-3-Clause', 'new bsd license': 'BSD-3-Clause', 'modified bsd': 'BSD-3-Clause',
  'bsd-3': 'BSD-3-Clause', 'bsd 3-clause': 'BSD-3-Clause', '3-clause bsd': 'BSD-3-Clause', 'revised bsd': 'BSD-3-Clause',
  'simplified bsd': 'BSD-2-Clause', 'freebsd': 'BSD-2-Clause', 'bsd-2': 'BSD-2-Clause', 'bsd 2-clause': 'BSD-2-Clause', '2-clause bsd': 'BSD-2-Clause',
  'isc license': 'ISC', 'python software foundation license': 'PSF-2.0', psf: 'PSF-2.0', psfl: 'PSF-2.0', 'zlib/libpng': 'Zlib',
  'boost software license': 'BSL-1.0', 'boost software license 1.0': 'BSL-1.0', cc0: 'CC0-1.0', 'cc0 1.0': 'CC0-1.0',
  'eclipse public license 2.0': 'EPL-2.0', 'epl 2.0': 'EPL-2.0', 'eclipse public license 1.0': 'EPL-1.0', 'epl 1.0': 'EPL-1.0',
  'mpl 2.0': 'MPL-2.0', 'mozilla public license 2.0': 'MPL-2.0', 'mpl-2': 'MPL-2.0',
  gplv2: 'GPL-2.0-only', 'gpl v2': 'GPL-2.0-only', 'gpl-2': 'GPL-2.0-only', gpl2: 'GPL-2.0-only', 'gnu gpl v2': 'GPL-2.0-only',
  gplv3: 'GPL-3.0-only', 'gpl v3': 'GPL-3.0-only', 'gpl-3': 'GPL-3.0-only', gpl3: 'GPL-3.0-only', 'gnu gpl v3': 'GPL-3.0-only',
  'gnu general public license v3': 'GPL-3.0-only', 'gnu general public license v2': 'GPL-2.0-only',
  'gnu general public license v3 (gplv3)': 'GPL-3.0-only', 'gnu general public license v2 (gplv2)': 'GPL-2.0-only',
  'gnu general public license v3 or later (gplv3+)': 'GPL-3.0-or-later', 'gnu general public license v2 or later (gplv2+)': 'GPL-2.0-or-later',
  lgplv2: 'LGPL-2.0-only', 'lgplv2.1': 'LGPL-2.1-only', lgplv3: 'LGPL-3.0-only', 'lgpl v3': 'LGPL-3.0-only', 'lgpl-3': 'LGPL-3.0-only',
  'gnu lesser general public license v3 (lgplv3)': 'LGPL-3.0-only', 'gnu lesser general public license v2 (lgplv2)': 'LGPL-2.0-only',
  agplv3: 'AGPL-3.0-only', 'agpl v3': 'AGPL-3.0-only', 'agpl-3': 'AGPL-3.0-only', 'gnu affero general public license v3': 'AGPL-3.0-only',
  'gnu affero general public license v3 or later (agplv3+)': 'AGPL-3.0-or-later', 'the unlicense': 'Unlicense', 'unlicense': 'Unlicense',
  'business source license 1.1': 'BUSL-1.1', 'server side public license': 'SSPL-1.0', 'elastic license 2.0': 'Elastic-2.0'
}));

/* Families by the words a licence name uses, for names no table knows. Checked in order: AGPL contains GPL. */
const FAMILY_WORDS = Object.freeze([
  [/\bagpl|affero/i, 'network-copyleft'],
  [/non[- ]?commercial|\bcc-by-nc\b|business source|source[- ]available|commons clause/i, 'restricted'],
  [/\blgpl|lesser general public/i, 'weak-copyleft'],
  [/\bgpl|general public licen[cs]e/i, 'strong-copyleft'],
  [/\bmpl\b|mozilla public|eclipse public|\bcddl\b/i, 'weak-copyleft'],
  [/public domain/i, 'public-domain'],
  [/\bmit\b|\bapache\b|\bbsd\b|\bisc\b|\bzlib\b|\bboost\b|\bpsf\b|python software foundation/i, 'permissive']
]);

/* Exceptions that let a copyleft library be linked into other work on that work's own terms. */
const LINKING_EXCEPTIONS = new Set([
  'classpath-exception-2.0', 'gcc-exception-2.0', 'gcc-exception-3.1', 'llvm-exception', 'autoconf-exception-2.0',
  'autoconf-exception-3.0', 'bison-exception-2.2', 'font-exception-2.0', 'libtool-exception', 'fltk-exception',
  'wxwindows-exception-3.1', 'u-boot-exception-2.0', 'linux-syscall-note', 'openvpn-openssl-exception', 'lzma-exception',
  'qt-lgpl-exception-1.1', 'universal-foss-exception-1.0', 'gpl-cc-1.0', 'i2p-gpl-java-exception', 'ocaml-lgpl-linking-exception'
]);

/* Text that crosses into a report is plain, bounded and never a control character. */
function plain(value, limit = 120) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/* One identifier: the canonical one where SPDX knows it, with its family. */
function leaf(token) {
  const raw = String(token);
  const lower = raw.toLowerCase();
  const found = KNOWN.get(lower) || (DEPRECATED.has(lower) ? KNOWN.get(DEPRECATED.get(lower).toLowerCase()) : null);
  if (found) return { id: found.id, family: found.family };
  if (lower.endsWith('+')) {
    const base = KNOWN.get(lower.slice(0, -1)) || (DEPRECATED.has(lower) ? KNOWN.get(DEPRECATED.get(lower).toLowerCase()) : null);
    if (base) {
      const later = base.id.replace(/-only$/, '-or-later');
      return { id: KNOWN.has(later.toLowerCase()) ? later : `${base.id}+`, family: base.family };
    }
  }
  if (/^licenseref-/i.test(raw) || /^documentref-/i.test(raw)) return { id: plain(raw, 64), family: 'unknown' };
  return null;
}

/*
 * An SPDX expression as a tree: identifiers joined by AND and OR, grouped by
 * brackets, an identifier optionally WITH an exception. Bounded, and a
 * throw for anything that is not one -- the caller then reads it as a name.
 */
function parseExpression(text) {
  const tokens = String(text).replace(/[()]/g, bracket => ` ${bracket} `).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 40) throw new Error('not an expression');
  let position = 0;
  const peek = () => tokens[position];
  const operator = (token, word) => typeof token === 'string' && token.toLowerCase() === word;
  function primary() {
    const token = tokens[position];
    if (token === '(') {
      position += 1;
      const node = either();
      if (tokens[position] !== ')') throw new Error('unbalanced');
      position += 1;
      return node;
    }
    if (!token || token === ')' || ['and', 'or', 'with'].includes(token.toLowerCase())) throw new Error('expected a licence');
    position += 1;
    const resolved = leaf(token);
    if (!resolved) throw new Error('unknown identifier');
    if (operator(peek(), 'with')) {
      position += 1;
      const exception = tokens[position];
      if (!exception || exception === '(' || exception === ')') throw new Error('expected an exception');
      position += 1;
      return { leaf: resolved, exception: plain(exception, 64) };
    }
    return { leaf: resolved };
  }
  function both() {
    let node = primary();
    while (operator(peek(), 'and')) { position += 1; node = { and: [node, primary()] }; }
    return node;
  }
  function either() {
    let node = both();
    while (operator(peek(), 'or')) { position += 1; node = { or: [node, both()] }; }
    return node;
  }
  const tree = either();
  if (position !== tokens.length) throw new Error('trailing words');
  return tree;
}

function display(node) {
  if (node.leaf) return node.exception ? `${node.leaf.id} WITH ${node.exception}` : node.leaf.id;
  const [left, right] = node.and || node.or;
  const word = node.and ? 'AND' : 'OR';
  const side = child => (child.leaf ? display(child) : `(${display(child)})`);
  return `${side(left)} ${word} ${side(right)}`;
}

/*
 * What a tree asks of its user. A choice (OR) is the user's to make, so it
 * asks the least of its options that is known; a combination (AND) asks the
 * most of its parts, and a part that cannot be read leaves the whole unknown
 * unless something already known asks more.
 */
function familyOf(node) {
  if (node.leaf) {
    const family = node.leaf.family;
    if (node.exception && LINKING_EXCEPTIONS.has(node.exception.toLowerCase()) && (family === 'strong-copyleft' || family === 'weak-copyleft')) return 'weak-copyleft';
    return family;
  }
  const [a, b] = (node.and || node.or).map(familyOf);
  if (node.or) {
    if (a === 'unknown') return b;
    if (b === 'unknown') return a;
    return RANK[a] <= RANK[b] ? a : b;
  }
  if (a === 'unknown' || b === 'unknown') {
    const other = a === 'unknown' ? b : a;
    return RANK[other] >= RANK['strong-copyleft'] && other !== 'unknown' ? other : 'unknown';
  }
  return RANK[a] >= RANK[b] ? a : b;
}

/* The identifiers an expression names, for policy lists and compatibility. */
function leaves(node, out = []) {
  if (node.leaf) out.push(node);
  else (node.and || node.or).forEach(child => leaves(child, out));
  return out;
}

/*
 * Whatever a manifest, a lockfile or deps.dev says a licence is, read as
 * { expression, family, tree }. Composer lists a package's licences as a
 * choice, so an array is read as OR; npm's old object form carries a type.
 */
function readLicence(value) {
  if (Array.isArray(value)) {
    const parts = value.filter(item => typeof item === 'string' && item.trim()).slice(0, 6);
    if (!parts.length) return { expression: null, family: 'unknown', tree: null };
    return readLicence(parts.length === 1 ? parts[0] : parts.map(part => `(${part})`).join(' OR '));
  }
  if (value && typeof value === 'object') return readLicence(value.type || value.name || null);
  const text = plain(value, 300);
  if (!text) return { expression: null, family: 'unknown', tree: null };
  if (/^unlicen[cs]ed$/i.test(text) || /^proprietary$/i.test(text) || /^all rights reserved$/i.test(text)) return { expression: 'UNLICENSED', family: 'none', tree: null };
  if (/^see licen[cs]e in\b/i.test(text) || /^non-standard$/i.test(text) || /^other$/i.test(text) || /^custom$/i.test(text)) {
    return { expression: plain(text, 80), family: 'unknown', tree: null };
  }
  try {
    const tree = parseExpression(text);
    return { expression: plain(display(tree), 160), family: familyOf(tree), tree };
  } catch { /* A name, not an expression. */ }
  const alias = ALIASES.get(text.toLowerCase().replace(/[“”"']/g, '').replace(/\s+licen[cs]e$/i, ' license').trim()) ||
    ALIASES.get(text.toLowerCase().replace(/[“”"']/g, '').trim());
  if (alias) return readLicence(alias);
  const byWords = FAMILY_WORDS.find(([pattern]) => pattern.test(text));
  if (byWords) return { expression: plain(text, 80), family: byWords[1], tree: { leaf: { id: plain(text, 80), family: byWords[1] } } };
  return { expression: plain(text, 80), family: 'unknown', tree: null };
}

/* ---- The project's own licence ------------------------------------------------- */

/* LICENSE, LICENCE.md, LICENSE-MIT, COPYING, UNLICENSE -- never a source file such as license.js or license_check.py. */
const LICENCE_FILE = /^(?:un)?licen[cs]e(?:[-_][a-z0-9-]+)?(?:\.(?:md|txt|rst|markdown))?$|^copying(?:\.(?:md|txt|lesser))?$/i;
function isLicenceFile(filePath) {
  return !String(filePath).includes('/') && LICENCE_FILE.test(String(filePath));
}

/* A licence file recognised by the words only that licence's text uses. */
const LICENCE_TEXTS = Object.freeze([
  [/GNU AFFERO GENERAL PUBLIC LICENSE/, () => 'AGPL-3.0-only'],
  [/GNU LESSER GENERAL PUBLIC LICENSE/, text => (/Version 3/.test(text) ? 'LGPL-3.0-only' : 'LGPL-2.1-only')],
  [/GNU (?:LIBRARY )?GENERAL PUBLIC LICENSE/, text => (/Version 3/.test(text) ? 'GPL-3.0-only' : 'GPL-2.0-only')],
  [/Server Side Public License/i, () => 'SSPL-1.0'],
  [/Business Source License/i, () => 'BUSL-1.1'],
  [/Elastic License 2\.0/i, () => 'Elastic-2.0'],
  [/PolyForm Noncommercial/i, () => 'PolyForm-Noncommercial-1.0.0'],
  [/Mozilla Public License,? (?:Version|v\.?) ?2\.0/i, () => 'MPL-2.0'],
  [/Eclipse Public License - v 2\.0/i, () => 'EPL-2.0'],
  [/Eclipse Public License - v 1\.0/i, () => 'EPL-1.0'],
  [/European Union Public Licen[cs]e/i, () => 'EUPL-1.2'],
  [/Apache License[\s\S]{0,80}Version 2\.0/i, () => 'Apache-2.0'],
  [/Boost Software License/i, () => 'BSL-1.0'],
  [/This is free and unencumbered software released into the public domain/i, () => 'Unlicense'],
  [/CC0 1\.0 Universal/i, () => 'CC0-1.0'],
  [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, () => 'MIT'],
  [/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i,
    text => (/copyright notice and this permission notice appear in all copies/i.test(text) ? 'ISC' : '0BSD')],
  [/Redistribution and use in source and binary forms/i, text => (/All advertising materials/i.test(text) ? 'BSD-4-Clause' : /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause')]
]);

function tomlString(text, table, key) {
  const section = new RegExp(`^\\[${table.replace(/\./g, '\\.')}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
  if (!section) return null;
  const inline = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]{1,300})"`, 'm').exec(section[1]);
  if (inline) return inline[1];
  const tableForm = new RegExp(`^\\s*${key}\\s*=\\s*\\{[^}\\n]*\\btext\\s*=\\s*"([^"\\n]{1,300})"`, 'm').exec(section[1]);
  return tableForm ? tableForm[1] : null;
}

/*
 * What the project says it is released under: its root manifest's licence
 * field first, then its root licence file. A private package that names no
 * licence, or says UNLICENSED, is proprietary; a project that says nothing
 * anywhere is treated as proprietary too -- no licence is "all rights
 * reserved" -- and the summary says the licence was not found.
 */
function projectLicence(files) {
  const byPath = new Map(files.filter(file => typeof file.text === 'string').map(file => [file.path, file.text]));
  const candidates = [];
  const pkg = byPath.get('package.json');
  if (pkg) {
    try {
      const json = JSON.parse(pkg);
      if (json && (json.license || json.licenses)) candidates.push({ value: json.license || json.licenses, source: 'package.json' });
      else if (json && json.private === true) candidates.push({ value: 'UNLICENSED', source: 'package.json' });
    } catch { /* A manifest that does not parse says nothing. */ }
  }
  const composer = byPath.get('composer.json');
  if (composer) {
    try {
      const json = JSON.parse(composer);
      if (json && json.license) candidates.push({ value: json.license, source: 'composer.json' });
    } catch { /* Nothing. */ }
  }
  const cargo = byPath.get('Cargo.toml');
  if (cargo) {
    const value = tomlString(cargo, 'package', 'license');
    if (value) candidates.push({ value, source: 'Cargo.toml' });
  }
  const pyproject = byPath.get('pyproject.toml');
  if (pyproject) {
    const value = tomlString(pyproject, 'project', 'license') || tomlString(pyproject, 'tool.poetry', 'license');
    if (value) candidates.push({ value, source: 'pyproject.toml' });
    const classifier = /License :: OSI Approved :: ([^"\n]{2,80})"/.exec(pyproject);
    if (!value && classifier) candidates.push({ value: classifier[1], source: 'pyproject.toml' });
  }
  for (const candidate of candidates) {
    const read = readLicence(candidate.value);
    if (read.family !== 'unknown') return Object.freeze({ expression: read.expression, family: read.family === 'none' ? 'proprietary' : read.family, source: candidate.source, tree: read.tree });
  }
  const licenceFile = [...byPath.keys()].filter(isLicenceFile).sort()[0];
  if (licenceFile) {
    const text = byPath.get(licenceFile).slice(0, 64 * 1024);
    const match = LICENCE_TEXTS.find(([pattern]) => pattern.test(text));
    if (match) {
      const read = readLicence(match[1](text));
      return Object.freeze({ expression: read.expression, family: read.family, source: licenceFile, tree: read.tree });
    }
    return Object.freeze({ expression: null, family: 'proprietary', source: licenceFile, tree: null, unread: true });
  }
  return Object.freeze({ expression: null, family: 'proprietary', source: null, tree: null, missing: true });
}

/* ---- The repository's own policy ------------------------------------------------ */

const POLICY_PATHS = Object.freeze(['.nebulaverse/licences.json', '.nebulaverse/licenses.json']);
const POLICY_KEY = /^(?:npm|pypi|go|maven|packagist|rubygems|cargo|nuget):[^\s]{1,214}$/;

/*
 * A repository may say which licences it allows and which it refuses -- by
 * SPDX identifier or by family -- and name packages it has cleared, each with
 * a reason, which stay in the report as waived:
 *
 *   { "allow": ["permissive", "weak-copyleft", "MPL-2.0"],
 *     "deny": ["AGPL-3.0-only", "restricted"],
 *     "packages": { "npm:left-pad": "Cleared by legal, March 2026" } }
 *
 * A file that does not parse is reported as such rather than ignored in
 * silence, and a policy is bounded like everything else the audit reads.
 */
function readPolicy(files) {
  const file = files.find(candidate => POLICY_PATHS.includes(candidate.path) && typeof candidate.text === 'string');
  if (!file) return null;
  let json;
  try { json = JSON.parse(file.text); } catch { return Object.freeze({ path: file.path, invalid: true, allow: null, deny: [], packages: new Map() }); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return Object.freeze({ path: file.path, invalid: true, allow: null, deny: [], packages: new Map() });
  const terms = list => (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item.trim()).slice(0, 200)
    .map(item => (FAMILY_IDS.has(item.trim()) ? { family: item.trim() } : { id: (leaf(item.trim()) || { id: item.trim() }).id }));
  const packages = new Map();
  if (json.packages && typeof json.packages === 'object' && !Array.isArray(json.packages)) {
    for (const [key, reason] of Object.entries(json.packages).slice(0, 500)) {
      if (!POLICY_KEY.test(key)) continue;
      const [ecosystem, ...rest] = key.split(':');
      packages.set(`${ecosystem}:${rest.join(':').toLowerCase()}`, plain(typeof reason === 'string' ? reason : '', 200) || null);
    }
  }
  return Object.freeze({
    path: file.path,
    invalid: false,
    allow: Array.isArray(json.allow) ? terms(json.allow) : null,
    deny: terms(json.deny),
    packages
  });
}

function termMatches(term, node, family) {
  if (term.family) return term.family === family;
  return node.leaf && node.leaf.id.toLowerCase() === term.id.toLowerCase();
}

/*
 * Whether a licence passes a policy. A choice passes when any option does; a
 * combination only when every part does. An option is refused when a deny
 * term names it or its family, and, where the policy lists what it allows,
 * when no allow term does.
 */
function policyVerdict(tree, policy) {
  if (!policy || policy.invalid) return { denied: false, notAllowed: false };
  const refused = node => {
    if (node.or) return refused(node.or[0]) && refused(node.or[1]);
    if (node.and) return refused(node.and[0]) || refused(node.and[1]);
    const family = familyOf(node);
    if (policy.deny.some(term => termMatches(term, node, family))) return 'denied';
    if (policy.allow && !policy.allow.some(term => termMatches(term, node, family))) return 'not-allowed';
    return false;
  };
  const why = node => {
    if (node.or) { const a = why(node.or[0]); const b = why(node.or[1]); return a && b ? (a === 'denied' || b === 'denied' ? 'denied' : 'not-allowed') : false; }
    if (node.and) { const a = why(node.and[0]); const b = why(node.and[1]); return a === 'denied' || b === 'denied' ? 'denied' : a || b; }
    return refused(node);
  };
  const verdict = why(tree);
  return { denied: verdict === 'denied', notAllowed: verdict === 'not-allowed' };
}

/* Whether a policy speaks for a licence at all: an allow term that names it settles the default rules too. */
function policyAllows(tree, family, policy) {
  if (!policy || policy.invalid || !policy.allow) return false;
  return leaves(tree).every(node => policy.allow.some(term => termMatches(term, node, familyOf(node)))) ||
    policy.allow.some(term => term.family === family);
}

/* ---- Compatibility with the project's licence --------------------------------- */

/* Licences whose terms the GPL does not allow to be added to a GPL work. */
const GPL_INCOMPATIBLE = new Set(['BSD-4-Clause', 'OpenSSL', 'EPL-1.0', 'CDDL-1.0', 'CDDL-1.1', 'MPL-1.1', 'Apache-1.1', 'Apache-1.0', 'JSON', 'SSPL-1.0']);
/* And those only version 3 of it accepts: a GPL-2.0-only work cannot take them. */
const GPL2_ONLY_INCOMPATIBLE = new Set(['Apache-2.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'EPL-2.0']);
const GPL3_INCOMPATIBLE = new Set(['GPL-2.0-only', 'GPL-1.0-only']);

/*
 * Whether a dependency's licence can be combined into a work released under
 * the project's. Only the well-settled GNU conflicts are judged; anything
 * else is left to the family rules, which say what a licence asks rather
 * than claim a conflict the law has not settled.
 */
function compatibility(project, tree) {
  if (!project || !project.tree || !tree) return { compatible: true };
  const projectIds = leaves(project.tree).map(node => node.leaf.id);
  const gpl2Only = projectIds.every(id => /^(?:L?GPL-2\.0-only|GPL-1\.0-only)$/.test(id)) && projectIds.some(id => /^GPL-2\.0-only$/.test(id));
  const gpl3 = projectIds.every(id => /^(?:A|L)?GPL-3\.0-(?:only|or-later)$/.test(id));
  const anyGpl = projectIds.every(id => /^(?:A|L)?GPL-/.test(id)) && !projectIds.every(id => /^LGPL-/.test(id));
  if (!gpl2Only && !gpl3 && !anyGpl) return { compatible: true };
  const clash = node => {
    if (node.or) return clash(node.or[0]) && clash(node.or[1]);
    if (node.and) return clash(node.and[0]) || clash(node.and[1]);
    /* A linking exception is exactly what lets a GPL work use the library. */
    if (node.exception && LINKING_EXCEPTIONS.has(node.exception.toLowerCase())) return false;
    const id = node.leaf.id;
    return GPL_INCOMPATIBLE.has(id) || (gpl2Only && GPL2_ONLY_INCOMPATIBLE.has(id)) || (gpl3 && GPL3_INCOMPATIBLE.has(id));
  };
  return { compatible: !clash(tree), project: project.expression };
}

/* ---- Asking deps.dev ------------------------------------------------------------ */

const DEPS_DEV = 'https://api.deps.dev/v3/systems';
const DEPS_DEV_SYSTEM = Object.freeze({ npm: 'npm', pypi: 'pypi', go: 'go', maven: 'maven', cargo: 'cargo', nuget: 'nuget', rubygems: 'rubygems' });
const LIMITS = Object.freeze({ maxLookups: 600, concurrency: 8, maxResponseBytes: 128 * 1024 });

function nameKey(ecosystem, name) {
  if (ecosystem === 'pypi') return String(name).toLowerCase().replace(/[-_.]+/g, '-');
  return ['npm', 'go', 'maven', 'cargo'].includes(ecosystem) ? String(name) : String(name).toLowerCase();
}
function versionKey(entry) {
  return `${entry.ecosystem}:${nameKey(entry.ecosystem, entry.name)}@${entry.version}`;
}

function depsDevUrl(entry) {
  const system = DEPS_DEV_SYSTEM[entry.ecosystem];
  if (!system) return null;
  const name = entry.ecosystem === 'pypi' ? nameKey('pypi', entry.name) : entry.name;
  const version = entry.ecosystem === 'go' && !/^v/.test(entry.version) ? `v${entry.version}` : entry.version;
  return `${DEPS_DEV}/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

/*
 * The licence of each version that its lockfile did not state, asked of
 * deps.dev one version at a time, the project's own dependencies first,
 * within a bound. An answer lists the licences a version was released
 * under; more than one all apply. A question that is not answered leaves
 * that version unknown, never permissive.
 */
async function lookupLicences(inventory, transport, limits = LIMITS) {
  const answers = new Map();
  const wanted = [];
  const seen = new Set();
  let fromLock = 0;
  for (const entry of inventory) {
    const key = versionKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.license) { answers.set(key, { value: entry.license, source: 'lock' }); fromLock += 1; continue; }
    if (DEPS_DEV_SYSTEM[entry.ecosystem]) wanted.push(entry);
  }
  const asked = wanted.slice(0, limits.maxLookups);
  let answered = 0;
  if (transport) {
    await boundedMapLimit(asked, limits.concurrency, async entry => {
      const key = versionKey(entry);
      try {
        const response = await transport({ url: depsDevUrl(entry), profile: 'licence-query', method: 'GET', headers: { accept: 'application/json', 'user-agent': 'Nebulaverse-X-Audit/1.0' }, maxResponseBytes: limits.maxResponseBytes });
        const status = Number(response && response.statusCode);
        if (status === 404) { answers.set(key, { value: null, source: 'deps.dev', missing: true }); answered += 1; return; }
        if (status !== 200) throw new Error('unanswered');
        const body = JSON.parse(String(response.body || ''));
        const licences = Array.isArray(body && body.licenses) ? body.licenses.filter(item => typeof item === 'string' && item.trim()).slice(0, 6) : [];
        answers.set(key, { value: licences.length > 1 ? licences.map(item => `(${item})`).join(' AND ') : licences[0] || null, source: 'deps.dev' });
        answered += 1;
      } catch {
        answers.set(key, 'unknown');
      }
    });
  }
  for (const entry of wanted.slice(limits.maxLookups)) answers.set(versionKey(entry), 'not-asked');
  if (!transport) for (const entry of asked) answers.set(versionKey(entry), 'not-asked');
  return { answers, asked: transport ? asked.length : 0, answered, fromLock, total: seen.size };
}

/* ---- Findings ------------------------------------------------------------------ */

const RULES = Object.freeze({
  'LIC-001': { category: 'licences', severity: 'serious', title: 'A dependency must be shared with anyone who uses your service',
    why: 'Network copyleft (AGPL, SSPL, OSL) reaches past distribution: offering software that includes it over a network obliges you to publish the source of the whole combined work -- for SSPL, of everything used to run the service -- under the same licence.',
    fix: 'Replace the package with one under a permissive licence, buy a commercial licence from its authors where they offer one, or keep it in a separate program that talks to yours only over a network boundary its licence allows. Record a decision in .nebulaverse/licences.json if your lawyers have cleared it.' },
  'LIC-002': { category: 'licences', severity: 'serious', title: 'A strong-copyleft dependency ships with code under another licence',
    why: 'The GPL and licences like it require that a work including the package, once distributed -- an app, a binary, or a JavaScript bundle sent to browsers -- be released as a whole under the same licence, with its source.',
    fix: 'Replace it with a permissively licensed alternative, isolate it in a separate program, or release the project under a compatible copyleft licence. A package only your build uses does not ship; mark it as a development dependency.' },
  'LIC-003': { category: 'licences', severity: 'serious', title: 'A dependency forbids some uses, such as commercial ones',
    why: 'Non-commercial, source-available and field-of-use licences (Creative Commons NC and ND, the Business Source License, Elastic, PolyForm, the JSON licence) are not open source: using the package outside what they permit is using it without a licence.',
    fix: 'Check whether your use is one the licence permits; if not, replace the package or buy a licence that covers it. Record the decision in .nebulaverse/licences.json.' },
  'LIC-004': { category: 'licences', severity: 'warning', title: 'A dependency the project asks for states no licence that can be read',
    why: 'Code published without a licence is all rights reserved: nobody but its author may copy or ship it. A licence written only as a file name or in free text cannot be judged until someone reads it.',
    fix: 'Read the package’s licence text. If it grants the rights you need, clear it by name in .nebulaverse/licences.json; if it grants none, ask the author to add one or replace the package.' },
  'LIC-005': { category: 'licences', severity: 'serious', title: 'A dependency’s licence is refused by the repository’s licence policy',
    why: 'The repository’s own policy file names this licence, or its family, as one it does not accept, or lists what it accepts and this is not among them.',
    fix: 'Replace the package, or, if the policy is what should change, change it in the same pull request so the decision is reviewed.' },
  'LIC-006': { category: 'licences', severity: 'serious', title: 'A dependency’s licence cannot be combined with the project’s own',
    why: 'Some licences add terms the GPL does not allow a combined work to carry -- the four-clause BSD advertising clause, the OpenSSL licence, EPL 1.0, CDDL -- and a GPL-2.0-only work cannot take code under Apache-2.0 or GPL-3.0.',
    fix: 'Replace the package, find a release of it under a compatible licence, or, where the project can, release it under a licence both allow (GPL-2.0-or-later can become GPL-3.0).' },
  'LIC-007': { category: 'licences', severity: 'warning', title: 'The repository’s licence policy could not be read',
    why: 'The policy file is not a JSON object, so none of its terms were applied and the audit fell back to its default rules.',
    fix: 'Make the file a JSON object with "allow", "deny" and "packages" keys, as the audit’s documentation shows.' }
});

/*
 * The licence findings for a dependency inventory, one per package version,
 * placed where a reader would change it: the manifest line for a package the
 * project asked for, the lockfile for one that came with another. A package
 * only a developer installs never ships, so copyleft in it is not reported;
 * a restriction on use still is, one step softer.
 */
function licenceFindings(inventory, answers, { project, policy }) {
  const out = [];
  const families = Object.fromEntries(FAMILIES.map(family => [family.id, 0]));
  const packages = [];
  const counted = new Set();
  const status = { versions: 0, known: 0, unknown: 0, notAsked: 0, fromLock: 0, fromRegistry: 0 };
  if (policy && policy.invalid) out.push({ rule: 'LIC-007', path: policy.path, line: null });
  const projectFamily = project ? project.family : 'proprietary';
  const copyleftProject = ['strong-copyleft', 'network-copyleft'].includes(projectFamily);
  for (const entry of inventory) {
    const key = versionKey(entry);
    const answer = answers.get(key);
    const first = !counted.has(key);
    counted.add(key);
    if (first) status.versions += 1;
    if (!answer || answer === 'unknown' || answer === 'not-asked') {
      if (first) { families.unknown += 1; if (answer === 'not-asked') status.notAsked += 1; else status.unknown += 1; }
      continue;
    }
    const read = readLicence(answer.value);
    if (first) {
      families[read.family] += 1;
      if (read.family === 'unknown') status.unknown += 1; else status.known += 1;
      if (answer.source === 'lock') status.fromLock += 1; else status.fromRegistry += 1;
    }
    const detail = {
      package: entry.name, version: entry.version, ecosystem: entry.ecosystem, direct: Boolean(entry.direct), dev: Boolean(entry.dev),
      licence: read.expression, family: read.family, source: answer.source === 'lock' ? 'lockfile' : 'deps.dev'
    };
    if (first && read.family !== 'permissive' && read.family !== 'public-domain' && packages.length < 200) {
      packages.push(Object.freeze({ ...detail }));
    }
    if (!first) continue;
    const exempt = policy && !policy.invalid ? policy.packages.get(`${entry.ecosystem}:${String(entry.name).toLowerCase()}`) : undefined;
    const waiver = exempt !== undefined ? Object.freeze({ reason: exempt || 'Cleared in the repository’s licence policy', line: null, policy: policy.path }) : undefined;
    const place = { path: entry.path, line: entry.line || null };
    /* A softer finding -- a restriction on a tool only developers install, AGPL in a GPL project -- is a warning. */
    const push = (rule, { softer, ...extra } = {}) => out.push({
      rule, ...place, ...(softer ? { severity: 'warning' } : {}), detail: { ...detail, ...extra }, ...(waiver !== undefined ? { suppression: waiver } : {})
    });

    if (read.tree) {
      const verdict = policyVerdict(read.tree, policy);
      if (verdict.denied || verdict.notAllowed) { push('LIC-005', { policy: policy.path, reason: verdict.denied ? 'denied' : 'not-allowed' }); continue; }
      if (policyAllows(read.tree, read.family, policy)) continue;
      const fit = compatibility(project, read.tree);
      if (!fit.compatible && !entry.dev) { push('LIC-006', { project: fit.project }); continue; }
    }
    if (read.family === 'restricted') { push('LIC-003', entry.dev ? { softer: true } : {}); continue; }
    if (entry.dev) continue;
    if (read.family === 'network-copyleft' && projectFamily !== 'network-copyleft') { push('LIC-001', copyleftProject ? { softer: true } : {}); continue; }
    if (read.family === 'strong-copyleft' && !copyleftProject) { push('LIC-002'); continue; }
    if ((read.family === 'unknown' || read.family === 'none') && entry.direct) push('LIC-004', { none: read.family === 'none' });
  }
  packages.sort((a, b) => RANK[b.family] - RANK[a.family] || Number(a.dev) - Number(b.dev) || Number(b.direct) - Number(a.direct) || a.package.localeCompare(b.package));
  return {
    out,
    summary: {
      project: project ? { expression: project.expression, family: project.family, source: project.source, missing: Boolean(project.missing), unread: Boolean(project.unread) } : null,
      policy: policy ? { path: policy.path, invalid: Boolean(policy.invalid), allow: policy.allow ? policy.allow.length : null, deny: policy.deny.length, cleared: policy.packages.size } : null,
      families,
      status,
      packages
    }
  };
}

module.exports = Object.freeze({
  FAMILIES, RULES, LIMITS, POLICY_PATHS,
  readLicence, parseExpression, familyOf, projectLicence, isLicenceFile, readPolicy, policyVerdict, compatibility,
  lookupLicences, licenceFindings, depsDevUrl, versionKey
});
