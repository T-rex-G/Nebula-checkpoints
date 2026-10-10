'use strict';
// Executes the unchanged browser entrypoint through its exported lifecycle API.
// Only DOM, network, clock scheduling and EventSource boundaries are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const neural = fs.readFileSync(path.join(ROOT, 'public/neural.js'), 'utf8');
const now = '2026-10-08T10:00:00.000Z';
const sha = 'a'.repeat(40);
function harness(custom = {}) {
  const elements = new Map(['neuralRiskScore','neuralRiskHint','neuralRecoveryState','neuralRecoveryHint','neuralStreamLabel','neuralLastSync'].map(id => [id, { textContent: '', closest: () => ({ dataset: {} }) }]));
  const streams = [], requests = [], warnings = [];
  const listeners = new Map();
  const no = () => {};
  const timers = new Map(); let timerId = 0;
  const classList = { add: no, remove: no, toggle: no, contains: () => false };
  const data = {
    '/api/safety': { readOnly:false, freezeSync:false, protected:{} },
    'refs-snapshot': { defaultBranch:'main', refs:[{name:'main',sha,protected:true},{name:'feature',sha:'b'.repeat(40)}], tags:[] },
    'activity': { commits:[{sha,message:'Default branch commit',author:'Author',date:now}], pulls:[],issues:[],releases:[] },
    'audit-deps': { scanned:0,sources:[],vulnerable:[],details:{},osv:{available:true},dependabot:{alerts:[]} },
    'actions': [],
    '/api/security/sessions': {available:true,sessions:[{current:true,updated:now}]},
    'live-events/status': {available:true,connected:true},
    'intelligence/events': {available:true,events:[],cursor:'cursor0'},
    'signed-snapshots': {available:true,snapshots:[]},
    'access-surface': {available:true,partial:false,collaborators:[],deployKeys:[],webhooks:[],risk:{score:0,reasons:[]}},
    '/api/security/scanner-status': {builtin:{available:true},yara:{configured:false,required:false}},
    'exposure/findings': {findings:[],verifications:{}}
  };
  const c = {
    console:{error:(...a)=>warnings.push(a.join(' ')),warn:(...a)=>warnings.push(a.join(' '))},
    performance, state:{work:{owner:'acme',repo:'demo',branch:'feature'},me:{login:'operator',provider:'github'},settings:{motion:false}},
    document:{visibilityState:'visible',getElementById:id=>elements.get(id)||null,querySelector:()=>null,querySelectorAll:()=>[],body:{classList},documentElement:{dataset:{}},addEventListener:(name,callback)=>listeners.set(name,callback)},
    window:{addEventListener:no,innerWidth:1200}, localStorage:{getItem:()=>null,setItem:no},
    matchMedia:()=>({matches:false}), currentTab:()=> 'neural',
    requestAnimationFrame:()=>1,cancelAnimationFrame:no,setInterval:()=>1,clearInterval:no,setTimeout:cb=>{timers.set(++timerId,cb);return timerId;},clearTimeout:id=>timers.delete(id),AbortController,
    EventSource:class {constructor(url){this.url=url;this.handlers={};this.closed=false;streams.push(this);} addEventListener(name,cb){this.handlers[name]=cb;} close(){this.closed=true;} },
    api:async (url,options={})=>{requests.push(url);if(custom.api){const got=custom.api(url,data,options);if(got!==undefined)return await got;} const key=Object.keys(data).find(k=>url===k||url.includes(`/acme/demo/${k}`));if(!key)throw new Error('Unexpected '+url);return data[key];}
  };
  c.window.matchMedia=c.matchMedia;
  vm.runInNewContext(neural,c,{filename:`${ROOT}/public/neural.js`});
  return {c,ui:c.window.NebulaNeural,elements,streams,requests,warnings,data,timers,listeners};
}
async function settleCatchup(h){for(let i=0;i<40;i++){await new Promise(setImmediate);if(!h.ui.state.catchUpBusy)return;}throw new Error('Catch-up stuck');}

test('selected branch is requested and unrelated commits are never its HEAD or synthetic ancestry', async () => {
  const h=harness();
  h.data.activity.commits.push({sha:'c'.repeat(40),message:'Parallel history',date:now,parentShas:[]});
  await h.ui.refresh();
  assert.match(h.requests.find(url=>url.includes('/activity?')), /[?&]ref=feature(?:&|$)/);
  assert(!h.ui.state.edges.some(e=>e.source==='branch:feature' && e.type==='head commit'));
  assert(!h.ui.state.edges.some(e=>e.type==='previous commit'));
});

test('real branch heads and parent SHAs produce factual commit edges', async () => {
  const h=harness();
  h.data['refs-snapshot'].refs[1].sha=sha;
  h.data.activity.commits[0].parentShas=['c'.repeat(40)];
  h.data.activity.commits.push({sha:'c'.repeat(40),message:'Actual parent',date:now,parentShas:[]});
  await h.ui.refresh();
  assert(h.ui.state.edges.some(e=>e.source==='branch:feature'&&e.target==='commit:'+sha&&e.type==='head commit'));
  assert(h.ui.state.edges.some(e=>e.source==='commit:'+sha&&e.target==='commit:'+'c'.repeat(40)&&e.type==='parent commit'));
});

test('a failed later catch-up page cannot advance past discarded events', async () => {
  let phase='initial';
  const h=harness({api:url=>{
    if(!url.includes('/intelligence/events')||phase==='initial')return undefined;
    if(url.includes('after=cursor0'))return {available:true,events:[{id:'important',createdAt:now,summary:'Evidence',targetType:'repository'}],cursor:'cursor1',hasMore:true};
    if(url.includes('after=cursor1')&&phase==='failure')throw new Error('temporary outage');
    return {available:true,events:[],cursor:'cursor1',hasMore:false};
  }});
  h.ui.state.active=true;await h.ui.refresh();phase='failure';h.streams[0].handlers.ready();await settleCatchup(h);
  assert(h.ui.state.intelligenceCursor==='cursor0'||h.ui.state.data.intelligence.events.some(e=>e.id==='important'));
  phase='retry';h.streams[0].handlers.ready();await settleCatchup(h);
  assert(h.ui.state.data.intelligence.events.some(e=>e.id==='important'));
});

test('catch-up pagination budget remains explicit and schedules bounded continuation', async () => {
  let sequence=0;
  const h=harness({api:url=>{
    if(!url.includes('after='))return undefined;
    sequence++;
    return {available:true,events:[{id:'event-'+sequence,createdAt:now,summary:'Event',targetType:'repository'}],cursor:'cursor'+sequence,hasMore:sequence<6};
  }});
  h.ui.state.active=true;await h.ui.refresh();h.streams[0].handlers.ready();await settleCatchup(h);
  assert.equal(sequence,5);assert.equal(h.ui.state.data.intelligence.hasMore,true);assert(h.timers.size>0);
  const callbacks=[...h.timers.values()];h.timers.clear();callbacks.forEach(cb=>cb());await settleCatchup(h);
  assert.equal(sequence,6);assert.equal(h.ui.state.data.intelligence.hasMore,false);
});

test('returning to a cached map reconnects and reports live only after ready', async () => {
  const h=harness();h.ui.state.active=true;await h.ui.refresh();
  assert(!h.elements.get('neuralStreamLabel').textContent.includes('VERIFIED LIVE'));
  h.streams[0].handlers.ready();await settleCatchup(h);
  h.ui.deactivate();assert(h.streams[0].closed);h.ui.activate();await new Promise(setImmediate);
  assert.equal(h.streams.length,2);assert(h.ui.state.eventSource);
  assert(!h.elements.get('neuralStreamLabel').textContent.includes('VERIFIED LIVE'));
  h.streams[1].handlers.ready();await settleCatchup(h);
  assert(h.elements.get('neuralStreamLabel').textContent.includes('VERIFIED LIVE'));
  h.ui.deactivate();
});

test('unavailable reads cannot claim a clean current scan or synthesize a session', async () => {
  const h=harness({api:()=>{throw new Error('unavailable');}});await h.ui.refresh();
  assert.match(h.elements.get('neuralRiskScore').textContent,/incomplete|unknown/i);
  assert(!h.elements.get('neuralRiskHint').textContent.includes('No critical signals'));
  assert(!h.ui.state.nodes.some(n=>n.type==='session'));
});

test('partial activity and invalid timestamps remain honest without demonstration fallback', async () => {
  const h=harness();h.data.activity.partial=true;h.data.activity.sources={commits:{available:false}};
  h.data.activity.commits[0].date='invalid timestamp';await h.ui.refresh();
  assert.equal(h.ui.state.demo,false);assert.equal(h.warnings.length,0);
  assert.match(h.elements.get('neuralRiskScore').textContent,/incomplete|unknown/i);
  assert(!h.ui.state.events.some(e=>e.type==='commit'));
});

test('invalid signature never counts as verified recovery protection', async () => {
  const h=harness();h.data['signed-snapshots'].snapshots=[{snapshotId:'bad',signatureValid:false,signature:'invalid',createdAt:now,snapshot:{refs:[],tags:[]}}];await h.ui.refresh();
  assert.match(h.elements.get('neuralRecoveryState').textContent,/unverified|invalid/i);
  assert(!h.ui.state.edges.some(e=>e.type==='cryptographically protects'));
  assert.notEqual(h.ui.state.nodes.find(n=>n.type==='snapshot').severity,'normal');
});

test('critical Exposure findings cannot coexist with a low risk clean hint', async () => {
  const h=harness();h.data['exposure/findings'].findings=[{fingerprint:'open-leak',rule:'github-token',disposition:'open',narration:{severity:'critical'}}];await h.ui.refresh();
  assert.match(h.elements.get('neuralRiskScore').textContent,/Critical/);
  assert.match(h.elements.get('neuralRiskHint').textContent,/credential|exposure/i);
});

test('reset aborts map reads and late responses cannot populate a new repository', async () => {
  let finish;let signal;
  const h=harness({api:(url,_data,options)=>{if(url.includes('/activity?')){signal=options.signal;return new Promise(resolve=>finish=resolve);}return undefined;}});
  const pending=h.ui.refresh();assert(signal);h.ui.reset();assert(signal.aborted);
  h.c.state.work={owner:'other',repo:'new',branch:'main'};
  finish({commits:[],pulls:[],issues:[],releases:[]});await pending;
  assert.equal(h.ui.state.nodes.length,0);assert.equal(h.ui.state.data,null);
});

test('browser API forwards caller cancellation to fetch', async () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const start = app.indexOf('async function api(');
  const end = app.indexOf('\n}\n', start) + 2;
  const context = {
    offlineHeadersForPath: () => ({}),
    fetch: (_url, options) => {
      assert(options.signal, 'the actual shared API adapter must pass the caller signal');
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
  };
  vm.runInNewContext(app.slice(start, end), context);
  const controller = new AbortController();
  const pending = context.api('/api/repo/acme/demo/activity', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a no-progress catch-up cursor remains retriable without acknowledging evidence', async () => {
  let catchingUp = false;
  const h=harness({api:url=>{
    if(!catchingUp||!url.includes('intelligence/events'))return undefined;
    return {available:true,events:[{id:'unacknowledged',createdAt:now,summary:'Event'}],cursor:'cursor0',hasMore:true};
  }});
  h.ui.state.active=true;await h.ui.refresh();catchingUp=true;h.streams[0].handlers.ready();await settleCatchup(h);
  assert.equal(h.ui.state.intelligenceCursor,'cursor0');
  assert.equal(h.ui.state.data.intelligence.events.length,0);
  assert.match(h.elements.get('neuralStreamLabel').textContent,/unavailable/i);
  assert(h.timers.size>0);
});

test('callbacks from a closed stream cannot affect the current repository', async () => {
  const h=harness();h.ui.state.active=true;await h.ui.refresh();const old=h.streams[0];
  h.ui.reset();const requests=h.requests.length;
  old.handlers.ready();old.handlers.intelligence({data:'{}'});old.onerror();
  await new Promise(setImmediate);
  assert.equal(h.requests.length,requests);assert.equal(h.timers.size,0);
  assert.equal(h.ui.state.liveStatus,'disconnected');
});

test('returning from a hidden tab restarts its cancelled first map load', async () => {
  let finish;let signal;let first=true;
  const h=harness({api:(url,_data,options)=>{
    if(!url.includes('/activity?')||!first)return undefined;
    first=false;signal=options.signal;return new Promise(resolve=>finish=resolve);
  }});
  h.ui.activate();
  h.c.document.visibilityState='hidden';h.listeners.get('visibilitychange')();
  assert(signal.aborted);
  h.c.document.visibilityState='visible';h.listeners.get('visibilitychange')();
  finish({commits:[],pulls:[],issues:[],releases:[]});await new Promise(setImmediate);
  assert.equal(h.ui.state.loadedKey,'acme/demo@feature');assert(h.ui.state.nodes.length>0);
});
