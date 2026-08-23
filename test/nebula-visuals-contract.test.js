'use strict';

/*
 * The artwork's supply chain.
 *
 * Every failure this guards has the same shape: a module that loads and then
 * cannot resolve something it needs, which shows up as a component that
 * silently does not appear rather than as an error anyone traces. So each
 * check resolves the path the browser would resolve and looks for the file on
 * disk, instead of matching the text of an import.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const publicRoot = path.join(root, 'public');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

/* The allowlist is the only way a /vendor path reaches a file. */
const allowlist = new Set(
  (/const VENDOR_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/.exec(server)[1].match(/'([^']+)'/g) || [])
    .map(entry => entry.slice(1, -1))
);
assert(allowlist.size >= 30, 'the vendor allowlist must be readable for this check to mean anything');

const MODULES = ['nebula-galaxy.js', 'nebula-mark-3d.js'];

for (const name of MODULES) {
  const source = fs.readFileSync(path.join(publicRoot, name), 'utf8');
  const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]);
  assert(imports.length > 0, `${name} must import the library it draws with`);

  for (const specifier of imports) {
    /*
     * A bare specifier would need an import map, an import map is an inline
     * script, and an inline script needs script-src relaxed. The absolute
     * path exists to avoid buying a policy exception with a convenience.
     */
    assert(
      specifier.startsWith('/'),
      `${name} imports the bare specifier ${specifier}, which only resolves behind an inline import map`
    );
    const served = path.join(publicRoot, specifier.replace(/^\//, ''));
    assert(fs.existsSync(served), `${name} imports ${specifier}, which this origin does not serve`);

    if (specifier.startsWith('/vendor/')) {
      const asset = specifier.replace('/vendor/', '');
      assert(allowlist.has(asset), `${specifier} is served from disk but the vendor route refuses it: ${asset}`);
    }
  }
}

/*
 * three.js imports its own core by relative specifier, so the two files only
 * resolve as siblings. Copying one and not the other leaves a module that
 * loads and then fails on its own import.
 */
{
  const entry = path.join(publicRoot, 'vendor', 'three', '0.185.1', 'three.module.min.js');
  assert(fs.existsSync(entry), 'the three.js entry module must be vendored');
  const source = fs.readFileSync(entry, 'utf8');
  const relative = [...source.matchAll(/["'](\.\/[^"']+\.js)["']/g)].map(match => match[1]);
  assert(relative.length > 0, 'three.js must be the split build this check was written for');
  for (const specifier of new Set(relative)) {
    const sibling = path.resolve(path.dirname(entry), specifier);
    assert(fs.existsSync(sibling), `three.js imports ${specifier}, which was not vendored beside it`);
    const asset = path.relative(path.join(publicRoot, 'vendor'), sibling).split(path.sep).join('/');
    assert(allowlist.has(asset), `three.js imports ${specifier}, which the vendor route refuses`);
  }
}

/*
 * The download is the point of the loader. If anything could mount the artwork
 * without first establishing that the device can draw it, a reader without
 * WebGL would pay 750KB for a blank frame.
 */
{
  const loader = fs.readFileSync(path.join(publicRoot, 'nebula-visuals.js'), 'utf8');
  const mount = loader.slice(loader.indexOf('async function mount('));
  const guard = mount.indexOf('supportsWebGL()');
  const load = mount.indexOf('import(');
  assert(guard > -1 && load > -1, 'the loader must probe for WebGL and import behind that probe');
  assert(guard < load, 'the WebGL probe must be resolved before the module import is started');
  assert(
    /saveData/.test(loader),
    'a metered connection must be able to decline the artwork'
  );
  /*
   * "Has a context" is not "can draw this". A machine with no usable GPU still
   * returns one -- Chrome falls back to SwiftShader, Mesa to llvmpipe -- and
   * these shaders on a CPU rasteriser starve the interface rather than merely
   * running slowly.
   */
  const probe = loader.slice(loader.indexOf('function supportsWebGL('));
  assert(
    /UNMASKED_RENDERER_WEBGL/.test(probe) && /swiftshader/i.test(loader),
    'the probe must reject a software rasteriser, not just a missing context'
  );

  /*
   * The app must reach the artwork through the loader. A direct import in the
   * shell would defeat every check the loader makes and pull three.js into the
   * first paint.
   */
  const app = fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
  for (const name of MODULES) {
    assert(!app.includes(`/${name}`), `app.js must not load ${name} directly; the loader decides whether to`);
  }
}

/* Decoration is never announced. */
for (const name of MODULES) {
  const source = fs.readFileSync(path.join(publicRoot, name), 'utf8');
  assert(
    source.includes("setAttribute('aria-hidden', 'true')"),
    `${name} draws decoration and must hide itself from assistive technology`
  );
}

/*
 * The worker must know about the loader and must not warm the heavy modules.
 * Warming them would spend the whole download on install, for every reader,
 * including the ones who never open a screen that draws them.
 */
{
  const worker = fs.readFileSync(path.join(publicRoot, 'sw.js'), 'utf8');
  assert(worker.includes('/nebula-visuals.js?v='), 'the worker must precache the artwork loader');
  const lists = worker.slice(0, worker.indexOf("addEventListener('install'"));
  for (const heavy of ['three.module.min.js', 'nebula-galaxy.js', 'nebula-mark-3d.js']) {
    assert(!lists.includes(heavy), `${heavy} must not be warmed on install; it is cached on first use`);
  }
}

console.log('nebula visuals contract tests passed');
