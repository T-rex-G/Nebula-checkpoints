'use strict';

/*
 * Every ecosystem the advisory lookup covers: what each manifest declares,
 * what each lockfile resolved and requires, how the code names a package in
 * each language, and the package URL an SBOM writes for it. A version the
 * file does not state is left out, never guessed.
 */

const assert = require('assert');
const eco = require('../src/ecosystems');
const audit = require('../src/code-audit');
const { usageIndex } = require('../src/uranus-reach');

const isTest = filePath => /(^|\/)(tests?|spec)\/|_test\.go$|Test\.java$/.test(filePath);
const summary = list => list.map(item => `${item.name}@${item.version || item.spec}${item.dev ? ':dev' : ''}${item.top ? ':top' : ''}`);

/* ---- Go ---------------------------------------------------------------------------- */
{
  const goMod = [
    'module example.com/app', '', 'go 1.21', '',
    'require (',
    '\tgithub.com/gin-gonic/gin v1.6.0',
    '\tgolang.org/x/net v0.0.0-20210405180319-a5a99cb37ef4 // indirect',
    '\tgithub.com/old/thing v1.0.0',
    '\tgithub.com/local/fork v1.0.0',
    ')', '',
    'require github.com/pkg/errors v0.9.1+incompatible', '',
    'replace github.com/old/thing => github.com/new/thing v1.2.0',
    'replace github.com/local/fork => ../fork', ''
  ].join('\n');
  const parsed = eco.goModEntries(goMod);
  assert.deepStrictEqual(summary(parsed.entries), [
    'github.com/gin-gonic/gin@v1.6.0:top', 'golang.org/x/net@v0.0.0-20210405180319-a5a99cb37ef4', 'github.com/new/thing@v1.2.0:top', 'github.com/pkg/errors@v0.9.1:top'
  ], 'indirect modules are not top; a replacement is followed; a local path is not a version');
  assert.strictEqual(parsed.entries[0].line, 6);
}

/* ---- Maven and Gradle ----------------------------------------------------------------- */
{
  const pom = [
    '<project>', '  <version>3.1.0</version>',
    '  <properties><log4j.version>2.14.1</log4j.version><jackson.version>2.9.8</jackson.version></properties>',
    '  <dependencyManagement><dependencies>',
    '    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>${jackson.version}</version></dependency>',
    '  </dependencies></dependencyManagement>',
    '  <dependencies>',
    '    <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>${log4j.version}</version></dependency>',
    '    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency>',
    '    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version><scope>test</scope></dependency>',
    '    <dependency><groupId>com.example</groupId><artifactId>from-parent</artifactId></dependency>',
    '    <!-- <dependency><groupId>commented</groupId><artifactId>out</artifactId><version>1.0</version></dependency> -->',
    '  </dependencies>',
    '  <build><plugins><plugin><dependencies><dependency><groupId>plugin</groupId><artifactId>only</artifactId><version>1.0</version></dependency></dependencies></plugin></plugins></build>',
    '  <profiles><profile><build><plugins><plugin><dependencies><dependency><groupId>profile</groupId><artifactId>plugin</artifactId><version>1.0</version></dependency></dependencies></plugin></plugins></build></profile></profiles>',
    '</project>'
  ].join('\n');
  const packages = eco.pomPackages({ path: 'pom.xml', text: pom });
  assert.deepStrictEqual(summary(packages), [
    'org.apache.logging.log4j:log4j-core@2.14.1', 'com.fasterxml.jackson.core:jackson-databind@2.9.8', 'junit:junit@4.12:dev', 'com.example:from-parent@'
  ], 'properties and dependency management resolve versions; build plugins and comments are not dependencies');
  assert.strictEqual(packages[0].line, 8);

  const gradle = eco.gradlePackages({ path: 'build.gradle.kts', text: 'dependencies {\n  implementation("org.springframework:spring-web:5.3.0")\n  testImplementation \'junit:junit:4.12\'\n  implementation("com.example:dynamic:$version")\n  kapt("com.google.dagger:dagger-compiler:2.40")\n}\n' });
  assert.deepStrictEqual(summary(gradle), ['org.springframework:spring-web@5.3.0', 'junit:junit@4.12:dev', 'com.google.dagger:dagger-compiler@2.40:dev']);
  const lock = eco.gradleLockEntries('# comment\norg.springframework:spring-web:5.3.0=compileClasspath,runtimeClasspath\njunit:junit:4.12=testCompileClasspath,testRuntimeClasspath\nempty=annotationProcessor\n');
  assert.deepStrictEqual(summary(lock.entries), ['org.springframework:spring-web@5.3.0', 'junit:junit@4.12:dev']);
}

/* ---- Composer ------------------------------------------------------------------------ */
{
  const manifest = eco.composerJsonPackages({ path: 'composer.json', text: JSON.stringify({ require: { php: '>=7.4', 'ext-json': '*', 'guzzlehttp/guzzle': '^6.3' }, 'require-dev': { 'phpunit/phpunit': '^9' } }, null, 2) });
  assert.deepStrictEqual(summary(manifest), ['guzzlehttp/guzzle@^6.3', 'phpunit/phpunit@^9:dev'], 'platform requirements are not packages');
  const lock = eco.composerLockEntries(JSON.stringify({ packages: [
    { name: 'guzzlehttp/guzzle', version: '6.3.0', require: { php: '>=5.5', 'guzzlehttp/psr7': '^1.4' }, autoload: { 'psr-4': { 'GuzzleHttp\\': 'src/' } }, license: ['MIT'] },
    { name: 'guzzlehttp/psr7', version: 'v1.4.2', autoload: { 'psr-4': { 'GuzzleHttp\\Psr7\\': 'src/' } } }
  ], 'packages-dev': [{ name: 'phpunit/phpunit', version: '9.5.0' }] }, null, 2));
  assert.deepStrictEqual(summary(lock.entries), ['guzzlehttp/guzzle@6.3.0', 'guzzlehttp/psr7@1.4.2', 'phpunit/phpunit@9.5.0:dev'], 'a leading v is not part of the version');
  assert.deepStrictEqual(lock.entries[0].requires, ['guzzlehttp/psr7']);
  assert.deepStrictEqual(lock.entries[0].namespaces, ['GuzzleHttp\\']);
  assert.deepStrictEqual(lock.entries[0].license, ['MIT']);
}

/* ---- Bundler ------------------------------------------------------------------------- */
{
  const gemfile = eco.gemfilePackages({ path: 'Gemfile', text: "source 'https://rubygems.org'\ngem 'rails', '~> 6.1.0'\ngem 'nokogiri', '1.10.0'\ngroup :development, :test do\n  if ENV['CI']\n    gem 'simplecov'\n  end\n  gem 'rspec-rails'\nend\nplatforms :jruby do\n  gem 'jdbc'\nend\ngem 'pry', group: :development\n" });
  assert.deepStrictEqual(summary(gemfile), ['rails@~> 6.1.0', 'nokogiri@1.10.0', 'simplecov@:dev', 'rspec-rails@:dev', 'jdbc@', 'pry@:dev'], 'an inner block closes before its group does');
  const lock = eco.gemfileLockEntries([
    'GEM', '  remote: https://rubygems.org/', '  specs:',
    '    nokogiri (1.10.0-x86_64-linux)', '      racc (~> 1.4)',
    '    nokogiri (1.10.0-arm64-darwin)', '      racc (~> 1.4)',
    '    racc (1.4.16)', '    rails (6.1.4)', '      nokogiri (>= 1.6)', '',
    'PLATFORMS', '  x86_64-linux', '',
    'DEPENDENCIES', '  nokogiri (= 1.10.0)', '  rails (~> 6.1.0)', ''
  ].join('\n'));
  assert.deepStrictEqual(summary(lock.entries), ['nokogiri@1.10.0', 'racc@1.4.16', 'rails@6.1.4'], 'a platform build is the same version, listed once');
  assert.deepStrictEqual(lock.entries[0].requires, ['racc']);
  assert.deepStrictEqual(lock.roots.map(root => root.name), ['nokogiri', 'rails']);
}

/* ---- Cargo --------------------------------------------------------------------------- */
{
  const manifest = eco.cargoTomlPackages({ path: 'Cargo.toml', text: '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.0.0", features = ["full"] }\nlocal = { path = "../local" }\nrenamed = { package = "real-name", version = "2" }\n\n[dev-dependencies]\ncriterion = "0.3"\n' });
  assert.deepStrictEqual(summary(manifest), ['serde@1.0', 'tokio@1.0.0', 'real-name@2', 'criterion@0.3:dev'], 'a path dependency is not a published version; a rename names the real crate');
  const lock = eco.cargoLockEntries('version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "serde",\n "tokio 1.0.0",\n]\n\n[[package]]\nname = "tokio"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\ndependencies = ["mio"]\n\n[[package]]\nname = "mio"\nversion = "0.7.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "serde"\nversion = "1.0.100"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n');
  assert.deepStrictEqual(summary(lock.entries), ['tokio@1.0.0', 'mio@0.7.0', 'serde@1.0.100'], 'the workspace crate itself is not a dependency');
  assert.deepStrictEqual(lock.roots.map(root => root.name), ['serde', 'tokio']);
  assert.deepStrictEqual(lock.entries[0].requires, ['mio']);
}

/* ---- NuGet --------------------------------------------------------------------------- */
{
  const csproj = eco.msbuildPackages({ path: 'src/App/App.csproj', text: '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />\n    <PackageReference Include="StyleCop.Analyzers" Version="1.1.118">\n      <PrivateAssets>all</PrivateAssets>\n    </PackageReference>\n    <PackageReference Include="Serilog">\n      <Version>2.10.0</Version>\n    </PackageReference>\n  </ItemGroup>\n</Project>\n' });
  assert.deepStrictEqual(summary(csproj), ['Newtonsoft.Json@12.0.1', 'StyleCop.Analyzers@1.1.118:dev', 'Serilog@2.10.0'], 'private assets are build tooling');
  const legacy = eco.msbuildPackages({ path: 'Web.csproj', text: '<Project>\n  <Reference Include="Newtonsoft.Json, Version=4.5.0.0, Culture=neutral">\n    <HintPath>..\\packages\\Newtonsoft.Json.4.5.11\\lib\\net40\\Newtonsoft.Json.dll</HintPath>\n  </Reference>\n  <Reference Include="System.Web" />\n  <Reference Include="MySql.Data, Version=6.4.4.0" />\n</Project>\n' });
  assert.deepStrictEqual(summary(legacy), ['Newtonsoft.Json@4.5.11'], 'the restored package folder names the version; an assembly version does not');
  assert.strictEqual(legacy[0].line, 3);
  const config = eco.packagesConfigPackages({ path: 'packages.config', text: '<packages>\n  <package id="jQuery" version="1.8.0" targetFramework="net45" />\n</packages>\n' });
  assert.deepStrictEqual(summary(config), ['jQuery@1.8.0']);
  const lock = eco.nugetLockEntries(JSON.stringify({ version: 1, dependencies: {
    'net6.0': { 'Newtonsoft.Json': { type: 'Direct', requested: '[12.0.1, )', resolved: '12.0.1', dependencies: {} },
      Serilog: { type: 'Direct', resolved: '2.10.0', dependencies: { 'System.Memory': '4.5.0' } },
      'System.Memory': { type: 'Transitive', resolved: '4.5.0' }, Lib: { type: 'Project' } },
    'net7.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '12.0.1' } }
  } }, null, 2));
  assert.deepStrictEqual(summary(lock.entries), ['Newtonsoft.Json@12.0.1:top', 'Serilog@2.10.0:top', 'System.Memory@4.5.0'], 'one entry per version across target frameworks; a project reference is not a package');
  assert.deepStrictEqual(lock.entries[1].requires, ['System.Memory']);
}

/* ---- Python manifests beyond requirements files ----------------------------------------- */
{
  const pep621 = eco.pyprojectPackages({ path: 'pyproject.toml', text: '[project]\nname = "app"\ndependencies = [\n  "requests>=2.20",\n  "django==3.2.0 ; python_version >= \'3.8\'",\n]\n\n[project.optional-dependencies]\ndev = ["pytest>=7"]\n' });
  assert.deepStrictEqual(summary(pep621), ['requests@>=2.20', 'django@==3.2.0', 'pytest@>=7:dev']);
  const poetry = eco.pyprojectPackages({ path: 'pyproject.toml', text: '[tool.poetry.dependencies]\npython = "^3.9"\nflask = "^1.0"\npyyaml = { version = "5.3", optional = true }\n\n[tool.poetry.group.dev.dependencies]\nblack = "22.1.0"\n' });
  assert.deepStrictEqual(summary(poetry), ['flask@^1.0', 'pyyaml@5.3', 'black@22.1.0:dev'], 'the Python version is not a package');
  const pipfile = eco.pipfilePackages({ path: 'Pipfile', text: '[packages]\nrequests = "==2.19.0"\nflask = "*"\n\n[dev-packages]\npytest = ">=6"\n' });
  assert.deepStrictEqual(summary(pipfile), ['requests@==2.19.0', 'flask@', 'pytest@>=6:dev']);
}

/* ---- Package URLs --------------------------------------------------------------------- */
{
  assert.strictEqual(eco.purl('npm', '@babel/core', '7.0.0'), 'pkg:npm/%40babel/core@7.0.0');
  assert.strictEqual(eco.purl('pypi', 'Django_Rest.Framework', '3.0'), 'pkg:pypi/django-rest-framework@3.0');
  assert.strictEqual(eco.purl('go', 'github.com/gin-gonic/gin', 'v1.6.0'), 'pkg:golang/github.com/gin-gonic/gin@v1.6.0');
  assert.strictEqual(eco.purl('maven', 'org.apache.logging.log4j:log4j-core', '2.14.1'), 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1');
  assert.strictEqual(eco.purl('packagist', 'guzzlehttp/guzzle', '6.3.0'), 'pkg:composer/guzzlehttp/guzzle@6.3.0');
  assert.strictEqual(eco.purl('rubygems', 'nokogiri', '1.10.0'), 'pkg:gem/nokogiri@1.10.0');
  assert.strictEqual(eco.purl('cargo', 'tokio', '1.0.0'), 'pkg:cargo/tokio@1.0.0');
  assert.strictEqual(eco.purl('nuget', 'Newtonsoft.Json', '12.0.1'), 'pkg:nuget/Newtonsoft.Json@12.0.1');
}

/* ---- Versions: what is exact, and what a range accepts -------------------------------------- */
{
  const floors = [['cargo', '1.2'], ['cargo', '=1.2.3'], ['packagist', '^6.3'], ['packagist', '~1.2'], ['rubygems', '~> 6.1.0'], ['rubygems', '>= 1.0, < 2'], ['pypi', '^1.0'], ['maven', '[1.0,2.0)']];
  assert.deepStrictEqual(floors.map(([ecosystem, spec]) => audit.rangeFloor(spec, ecosystem)), ['1.2.0', '1.2.3', '6.3.0', '1.2.0', '6.1.0', '1.0.0', '1.0.0', null]);
  const ceilings = [['cargo', '1.2'], ['packagist', '~1.2'], ['packagist', '~1.2.3'], ['rubygems', '~> 6.1'], ['rubygems', '~> 6.1.0'], ['pypi', '^1.0'], ['rubygems', '>= 1.0']];
  assert.deepStrictEqual(ceilings.map(([ecosystem, spec]) => audit.rangeCeiling(spec, ecosystem)), ['2.0.0', '2.0.0', '1.3.0', '7.0.0', '6.2.0', '2.0.0', null], 'caret for Cargo and Poetry, pessimistic for Composer ~ and Bundler ~>');
}

/* ---- One repository, every ecosystem: the inventory ------------------------------------------ */
const polyglot = [
  { path: 'README.md', text: '# app\n' },
  { path: 'go.mod', text: 'module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.6.0\n\tgolang.org/x/net v0.0.0-20210405180319-a5a99cb37ef4 // indirect\n)\n' },
  { path: 'cmd/server/main.go', text: 'package main\n\nimport (\n\t"fmt"\n\tweb "github.com/gin-gonic/gin/binding"\n)\n\nfunc main() { fmt.Println(web.JSON) }\n' },
  { path: 'java/pom.xml', text: '<project><dependencies><dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency><dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.9.8</version></dependency></dependencies></project>\n' },
  { path: 'java/src/main/java/App.java', text: 'import org.apache.logging.log4j.LogManager;\nimport com.fasterxml.jackson.databind.ObjectMapper;\nclass App {}\n' },
  { path: 'php/composer.json', text: JSON.stringify({ require: { 'guzzlehttp/guzzle': '^6.3' } }) },
  { path: 'php/composer.lock', text: JSON.stringify({ packages: [
    { name: 'guzzlehttp/guzzle', version: '6.3.0', require: { 'guzzlehttp/psr7': '^1.4' }, autoload: { 'psr-4': { 'GuzzleHttp\\': 'src/' } }, license: ['MIT'] },
    { name: 'guzzlehttp/psr7', version: '1.4.2', autoload: { 'psr-4': { 'GuzzleHttp\\Psr7\\': 'src/' } } }
  ] }, null, 2) },
  { path: 'php/src/Client.php', text: '<?php\nuse GuzzleHttp\\Client;\n$c = new Client();\n' },
  { path: 'ruby/Gemfile', text: "gem 'nokogiri', '1.10.0'\ngem 'rails'\n" },
  { path: 'ruby/Gemfile.lock', text: 'GEM\n  specs:\n    nokogiri (1.10.0)\n    rails (6.1.4)\n      nokogiri (>= 1.6)\n\nDEPENDENCIES\n  nokogiri (= 1.10.0)\n  rails\n' },
  { path: 'ruby/config/application.rb', text: "require_relative 'boot'\nrequire 'rails/all'\nBundler.require(*Rails.groups)\n" },
  { path: 'rust/Cargo.toml', text: '[dependencies]\ntokio = "1.0.0"\n' },
  { path: 'rust/Cargo.lock', text: '[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["tokio"]\n\n[[package]]\nname = "tokio"\nversion = "1.0.0"\nsource = "registry+x"\ndependencies = ["mio"]\n\n[[package]]\nname = "mio"\nversion = "0.7.0"\nsource = "registry+x"\n' },
  { path: 'rust/src/main.rs', text: 'use tokio::runtime::Runtime;\nfn main() {}\n' },
  { path: 'dotnet/App.csproj', text: '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="12.0.1" /><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="2.1.0" /></ItemGroup></Project>' },
  { path: 'dotnet/Program.cs', text: 'using Newtonsoft.Json.Linq;\nusing Microsoft.EntityFrameworkCore;\nclass P {}\n' }
];
{
  const { inventory, graphs } = audit.readDependencies(polyglot);
  const line = entry => `${entry.ecosystem}:${entry.name}@${entry.version}:${entry.source}:${entry.direct ? 'direct' : 'transitive'}`;
  assert.deepStrictEqual(inventory.map(line).sort(), [
    'cargo:mio@0.7.0:lock:transitive', 'cargo:tokio@1.0.0:lock:direct',
    'go:github.com/gin-gonic/gin@v1.6.0:lock:direct', 'go:golang.org/x/net@v0.0.0-20210405180319-a5a99cb37ef4:lock:transitive',
    'maven:com.fasterxml.jackson.core:jackson-databind@2.9.8:pin:direct', 'maven:org.apache.logging.log4j:log4j-core@2.14.1:pin:direct',
    'nuget:Microsoft.EntityFrameworkCore.SqlServer@2.1.0:pin:direct', 'nuget:Newtonsoft.Json@12.0.1:pin:direct',
    'packagist:guzzlehttp/guzzle@6.3.0:lock:direct', 'packagist:guzzlehttp/psr7@1.4.2:lock:transitive',
    'rubygems:nokogiri@1.10.0:lock:direct', 'rubygems:rails@6.1.4:lock:direct'
  ], 'go.mod is its own lockfile, and its direct requirements are direct');
  assert.deepStrictEqual(audit.introducedThrough(graphs.get('rust/Cargo.lock'), 'mio').chain, ['tokio', 'mio']);
  assert.deepStrictEqual(audit.introducedThrough(graphs.get('php/composer.lock'), 'guzzlehttp/psr7').chain, ['guzzlehttp/guzzle', 'guzzlehttp/psr7']);
}

/* ---- And where the code reaches each one ----------------------------------------------------- */
{
  const wanted = [
    { ecosystem: 'go', key: 'github.com/gin-gonic/gin', name: 'github.com/gin-gonic/gin' },
    { ecosystem: 'maven', key: 'com.fasterxml.jackson.core:jackson-databind', name: 'com.fasterxml.jackson.core:jackson-databind' },
    { ecosystem: 'packagist', key: 'guzzlehttp/guzzle', name: 'guzzlehttp/guzzle', namespaces: ['GuzzleHttp\\'] },
    { ecosystem: 'rubygems', key: 'nokogiri', name: 'nokogiri' },
    { ecosystem: 'cargo', key: 'tokio', name: 'tokio' },
    { ecosystem: 'nuget', key: 'newtonsoft.json', name: 'Newtonsoft.Json' },
    { ecosystem: 'nuget', key: 'microsoft.entityframeworkcore.sqlserver', name: 'Microsoft.EntityFrameworkCore.SqlServer' }
  ];
  const usage = usageIndex(polyglot, wanted, isTest);
  const how = (ecosystem, key) => usage[ecosystem].get(key) && usage[ecosystem].get(key).runtime && usage[ecosystem].get(key).runtime.how;
  assert.strictEqual(how('go', 'github.com/gin-gonic/gin'), 'import', 'a package inside the module, under an alias');
  assert.strictEqual(how('maven', 'com.fasterxml.jackson.core:jackson-databind'), 'import', 'jackson.databind is under the group com.fasterxml.jackson');
  assert.strictEqual(how('packagist', 'guzzlehttp/guzzle'), 'import', 'the namespace the package autoloads');
  assert.strictEqual(how('cargo', 'tokio'), 'import');
  assert.strictEqual(how('nuget', 'newtonsoft.json'), 'import', 'a namespace inside the package');
  assert.strictEqual(how('nuget', 'microsoft.entityframeworkcore.sqlserver'), 'name', 'a provider that extends a namespace the code opens');
  assert.strictEqual(usage.bundler, 'ruby/config/application.rb', 'Bundler.require loads the Gemfile at boot');

  /* The whole audit: advisories found in every ecosystem, each placed by reach. */
  const advisory = (id, cve, severity, cvss) => ({ advisories: [{ id, cve, rated: true, severity, cvss, summary: '', fixed: '99.0.0', malicious: false }] });
  const advisories = new Map([
    ['go:github.com/gin-gonic/gin@v1.6.0', advisory('GHSA-h395-qcrw-5vmq', 'CVE-2020-28483', 'serious', 7.1)],
    ['maven:org.apache.logging.log4j:log4j-core@2.14.1', advisory('GHSA-jfh8-c2jp-5v3q', 'CVE-2021-44228', 'critical', 10)],
    ['packagist:guzzlehttp/psr7@1.4.2', advisory('GHSA-q7rv-6hp3-vh96', 'CVE-2022-24775', 'serious', 7.5)],
    ['rubygems:nokogiri@1.10.0', advisory('GHSA-7rrm-v45f-jp64', 'CVE-2020-26247', 'warning', 4.3)],
    ['cargo:mio@0.7.0', advisory('GHSA-r8w9-5wcg-vfj7', 'CVE-2024-27308', 'serious', 7)],
    ['nuget:newtonsoft.json@12.0.1', advisory('GHSA-5crp-9r3c-p9vr', 'CVE-2024-21907', 'serious', 7.5)]
  ]);
  const intel = new Map([['CVE-2021-44228', { epss: 0.99999, percentile: 1, epssDate: '2026-09-28', kev: { added: '2021-12-10', due: '2021-12-24', ransomware: true } }]]);
  const result = audit.analyse({ files: polyglot, paths: polyglot.map(file => file.path), advisories, intel });
  const of = name => result.findings.find(finding => finding.detail && finding.detail.package === name);
  assert.strictEqual(of('github.com/gin-gonic/gin').detail.usage.tier, 'imported');
  assert.strictEqual(of('org.apache.logging.log4j:log4j-core').detail.usage.tier, 'imported');
  assert.strictEqual(of('org.apache.logging.log4j:log4j-core').detail.intel.ransomware, true);
  assert.strictEqual(of('org.apache.logging.log4j:log4j-core').detail.risk.band, 'urgent');
  assert.strictEqual(result.capReason, 'critical');
  assert.strictEqual(of('guzzlehttp/psr7').detail.usage.tier, 'transitive', 'brought in by guzzle, which the code uses');
  assert.deepStrictEqual(of('guzzlehttp/psr7').detail.usage.chain, ['guzzlehttp/guzzle', 'guzzlehttp/psr7']);
  assert.strictEqual(of('nokogiri').detail.usage.tier, 'named');
  assert.strictEqual(of('nokogiri').detail.usage.loader, 'bundler');
  assert.strictEqual(of('mio').detail.usage.tier, 'transitive');
  assert.strictEqual(of('Newtonsoft.Json').detail.usage.tier, 'imported');
  assert.match(of('org.apache.logging.log4j:log4j-core').prompt, /CISA lists CVE-2021-44228 as exploited in the wild/);

  /* The bill of materials names every component once, by package URL, with what it depends on. */
  const purls = result.components.map(component => component.purl);
  assert.strictEqual(new Set(purls).size, purls.length);
  assert(purls.includes('pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1'));
  assert.deepStrictEqual(result.components.find(component => component.name === 'guzzlehttp/guzzle').dependsOn, ['pkg:composer/guzzlehttp/psr7@1.4.2']);
  assert.strictEqual(result.components.find(component => component.name === 'guzzlehttp/guzzle').license[0], 'MIT');
}

/* ---- Every new manifest and lockfile is read before code, and a lockfile is never read as code -- */
{
  const entries = ['pom.xml', 'build.gradle.kts', 'go.mod', 'composer.json', 'composer.lock', 'Gemfile', 'Gemfile.lock', 'Cargo.toml', 'Cargo.lock', 'App.csproj', 'packages.lock.json', 'src/main.go']
    .map((path, index) => ({ path, sha: String(index).padStart(40, '0'), size: 100 }));
  const { selected } = audit.selectFiles(entries);
  assert.deepStrictEqual(selected.slice(-1).map(entry => entry.path), ['src/main.go'], 'manifests and lockfiles come before source');
  assert.strictEqual(selected.length, entries.length);
}

console.log('ecosystem tests passed');
