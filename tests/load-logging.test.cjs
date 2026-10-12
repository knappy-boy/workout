const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const logging = require('../logging.js');
const load = require('../exercise-load.js');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const snapshot = { kg: 80, date: '2026-10-10', sourceId: 'weigh-in' };
const strength = mode => ({type: 'strength', loadType: mode});

for (const [mode, weight, expected] of [['bodyweight', '', 80], ['assisted', '20', 60], ['weighted', '10', 90]]) {
  test(`${mode} records raw input and a fixed workout snapshot with a distinct load label`, () => {
    const result = logging.parseRows(strength(mode), [{a: weight, b: '8'}], 'kg', {snapshotNew: true, bodyweightSnapshot: snapshot});
    assert.equal(result.error, null);
    const set = result.entries[0];
    assert.equal(Number(set.w), Number(weight));
    assert.equal(set.loadType, mode);
    assert.equal(set.bodyweightKg, 80);
    assert.equal(set.bodyweightDate, snapshot.date);
    assert.equal(set.bodyweightSourceId, snapshot.sourceId);
    assert.equal(load.estimatedLoad(set), expected);
    assert.match(logging.formatStrengthSet(set, strength(mode), 'kg'), mode === 'bodyweight' ? /Bodyweight/ : mode === 'assisted' ? /20kg assistance/ : /10kg added/);
    assert.equal(logging.estimatedSetText(set, 'kg'), `≈ ${expected}kg estimated load`);
  });
}

test('missing bodyweight never blocks valid reps or invents an estimate; blank reps-only rows remain empty', () => {
  for (const mode of ['bodyweight', 'assisted', 'weighted']) {
    const parsed = logging.parseRows(strength(mode), [{a: mode === 'bodyweight' ? '' : '20', b: '8'}], 'kg', {snapshotNew: true, bodyweightSnapshot: null});
    assert.equal(parsed.error, null);
    assert.ok(!Object.hasOwn(parsed.entries[0], 'bodyweightKg'));
    assert.equal(load.estimatedLoad(parsed.entries[0]), null);
  }
  assert.deepEqual(logging.parseRows(strength('bodyweight'), [{a: '0', b: ''}], 'kg').entries, []);
  assert.match(logging.parseRows(strength('bodyweight'), [{a: '', b: '1.5'}], 'kg').error, /positive whole number/);
});

test('existing saved rows keep legacy meaning, exact raw values, snapshots and metadata after a library change', () => {
  const exercise = {...strength('weighted'), isAssisted: true};
  const sets = [{w: '18', r: '8', note: 'original', imported: {keep: true}},
    {w: 12.3456, r: 8, loadType: 'assisted', bodyweightKg: 75, bodyweightDate: '2026-04-01', bodyweightSourceId: 'old'}];
  const rows = logging.rowsFromSets(exercise, sets, 'lbs');
  assert.ok(rows.every(row => row.loadType === 'assisted'));
  assert.deepEqual(logging.parseRows(exercise, rows, 'lbs', {snapshotNew: true, bodyweightSnapshot: snapshot}).entries, sets);
  rows[0].b = '9';
  const result = logging.parseRows(exercise, rows, 'lbs', {snapshotNew: true, bodyweightSnapshot: snapshot});
  assert.deepEqual(result.entries, [{...sets[0],r:'9'},sets[1]]);
});

test('imported absent, null and blank legacy weights survive no-op and reps-only editing exactly', () => {
  for (const set of [{r:'8'}, {w:null,r:'8'}, {w:'',r:'8'}]) {
    const exercise = {type:'strength'};
    const rows = logging.rowsFromSets(exercise,[set],'kg');
    assert.deepEqual(logging.parseRows(exercise,rows,'kg').entries,[set]);
    assert.equal(logging.unchangedDraft(exercise,{rows,notes:'',unit:'kg'},[set],''),true);
    rows[0].b='10';
    assert.deepEqual(logging.parseRows(exercise,rows,'kg').entries,[{...set,r:'10'}]);
    rows[0].a='5';
    assert.deepEqual(logging.parseRows(exercise,rows,'kg').entries,[{...set,w:'5',r:'10'}]);
  }
});

test('next set copies only the current raw weight and snapshots the current override rather than past bodyweight', () => {
  const exercise = strength('weighted');
  const saved = {w:12.3456,r:8,loadType:'weighted',bodyweightKg:70,bodyweightDate:'2026-04-01',note:'old',completed:true};
  const old = logging.rowsFromSets(exercise,[saved],'lbs')[0];
  const next = {...logging.nextRow(exercise,[old]),b:'7'};
  assert.ok(!next.originalSet); assert.ok(!Object.hasOwn(next,'bodyweightKg'));
  const sets = logging.parseRows(exercise,[old,next],'lbs',{snapshotNew:true,bodyweightSnapshot:snapshot}).entries;
  assert.deepEqual(sets[0],saved);
  assert.equal(sets[1].w,12.3456); assert.equal(sets[1].bodyweightKg,80);
  assert.ok(!Object.hasOwn(sets[1],'note')); assert.ok(!Object.hasOwn(sets[1],'completed'));
  assert.deepEqual(logging.nextRow(strength('weighted'),[{...old,originalSet:{...saved,loadType:'assisted'}}]),{a:'',b:'',loadType:'weighted'});
  assert.deepEqual(logging.nextRow(strength('bodyweight'),[old]),{a:'',b:'',loadType:'bodyweight'});
  assert.deepEqual(logging.nextRow({type:'cardio',loadType:'weighted'},[old]),{a:'',b:''});
});

test('same routine lookup cannot copy or compare another load mode after an exercise default changes', () => {
  const exercise = {...strength('weighted'),isAssisted:true};
  const sessions = [
    {id:'legacy',start:'2026-10-12',templateId:'chest',entries:{dips:[{w:20,r:8}]}},
    {id:'assisted',start:'2026-10-11',templateId:'chest',entries:{dips:[{w:15,r:8,loadType:'assisted'}]}},
    {id:'weighted-other',start:'2026-10-10',templateId:'other',entries:{dips:[{w:12,r:8,loadType:'weighted'}]}},
    {id:'weighted-same',start:'2026-10-09',templateId:'chest',entries:{dips:[{w:10,r:8,loadType:'weighted'},{w:20,r:8,loadType:'assisted'}]}}
  ];
  const before=clone(sessions);
  const last=logging.findLast('dips',exercise,sessions,{templateId:'chest'});
  assert.equal(last.session.id,'weighted-same');
  assert.deepEqual(last.sets,[sessions[3].entries.dips[0]]);
  assert.deepEqual(sessions,before);
});

test('history-editor new rows can provide their own historical snapshot without adopting today’s value', () => {
  const row={a:'10',b:'8',loadType:'weighted',bodyweightKg:70,bodyweightDate:'2026-04-01',bodyweightSourceId:'then'};
  const result=logging.parseRows(strength('weighted'),[row],'kg',{bodyweightSnapshot:snapshot});
  assert.equal(result.entries[0].bodyweightKg,70);
  assert.equal(result.entries[0].bodyweightDate,'2026-04-01');
  assert.equal(result.entries[0].bodyweightSourceId,'then');
  assert.ok(!Object.hasOwn(logging.parseRows(strength('weighted'),[{...row,bodyweightKg:null}],'kg',{bodyweightSnapshot:snapshot}).entries[0],'bodyweightKg'));
});

test('workout bodyweight accepts exact raw decimal edits, preserves pound precision and treats invalid input as unknown', () => {
  const display=String(logging.displayWeight(80,'lbs'));
  const original={value:display,unit:'lbs',originalKg:80,originalDisplay:display,originalDate:'2026-10-10',originalSourceId:'weigh-in'};
  assert.deepEqual(logging.parseBodyweightInput(original,'2026-10-12'),snapshot);
  assert.deepEqual(logging.parseBodyweightInput({...original,value:'180.'},'2026-10-12'),{kg:180/2.20462,date:'2026-10-12'});
  for(const value of ['', '.', 'x', '-80', '0']) assert.equal(logging.parseBodyweightInput({value,unit:'kg'},'2026-10-12'),null);
});

function bodyweightHarness(session) {
  const nodes=new Map();
  const $=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:'',textContent:'',addEventListener(type,fn){this[type]=fn;}});return nodes.get(selector);};
  let writes=0;
  const context=vm.createContext({$,ACTIVE_SESSION:clone(session),DB:{exercises:{dips:strength('weighted')},bodyweight:[{id:'before',date:'2026-10-10',kg:80},{id:'after',date:'2026-10-13',kg:90}]},CURRENT_LOG_EX:'dips',CURRENT_LOG_MODE:'weighted',CURRENT_LOG_UNIT:'kg',LOG_SAVING:false,LiftLogExerciseLoad:load,LiftLogLogging:logging,LiftLogDates:require('../dates.js'),captureLogDraft:()=>{writes++;}});
  vm.runInContext(source.slice(source.indexOf('function setupWorkoutBodyweight()'),source.indexOf('function captureLogDraft()')),context);
  return {context,$,get writes(){return writes;}};
}

test('old active sessions capture bodyweight once as of their start, and raw partial edits survive re-opening',()=>{
  const h=bodyweightHarness({id:'session',start:'2026-10-12T10:00:00Z'});
  h.context.setupWorkoutBodyweight();
  assert.equal(h.context.ACTIVE_SESSION.bodyweightSnapshot.kg,80);
  h.context.DB.bodyweight.push({date:'2026-10-11',kg:85});
  h.context.setupWorkoutBodyweight();
  assert.equal(h.context.ACTIVE_SESSION.bodyweightSnapshot.kg,80);
  h.$('#logBodyweightInput').value='.'; h.$('#logBodyweightInput').input();
  const saved=clone(h.context.ACTIVE_SESSION);
  assert.equal(saved.bodyweightSnapshot,null); assert.equal(saved.bodyweightInput.value,'.'); assert.equal(h.writes,1);
  const reopened=bodyweightHarness(saved); reopened.context.setupWorkoutBodyweight();
  assert.equal(reopened.$('#logBodyweightInput').value,'.');
  assert.equal(reopened.context.ACTIVE_SESSION.bodyweightSnapshot,null);
});

test('an explicitly unknown snapshot is never filled from a later weigh-in',()=>{
  const h=bodyweightHarness({id:'session',start:'2026-10-12',bodyweightSnapshot:null});
  h.context.setupWorkoutBodyweight();
  assert.equal(h.$('#logBodyweightInput').value,'');
  assert.equal(h.context.ACTIVE_SESSION.bodyweightSnapshot,null);
});

test('workout bodyweight displays its fixed source date, preserves unchanged pound precision and dates overrides',()=>{
  const h=bodyweightHarness({id:'session',start:'2026-10-12T10:00:00Z',bodyweightSnapshot:snapshot});
  h.context.CURRENT_LOG_UNIT='lbs';
  h.context.setupWorkoutBodyweight();
  const date=h.$('#logBodyweightDate'), input=h.$('#logBodyweightInput');
  assert.equal(date.textContent,'10 Oct 2026'); assert.equal(date.dateTime,'2026-10-10'); assert.equal(date.hidden,false);
  const originalDisplay=input.value;
  input.input();
  assert.equal(h.context.ACTIVE_SESSION.bodyweightSnapshot.kg,80);
  assert.equal(date.textContent,'10 Oct 2026');
  input.value='180'; input.input();
  assert.equal(date.textContent,'12 Oct 2026'); assert.equal(date.dateTime,'2026-10-12T10:00:00Z');
  assert.ok(!Object.hasOwn(h.context.ACTIVE_SESSION.bodyweightSnapshot,'sourceId'));
  input.value=originalDisplay; input.input();
  assert.equal(date.textContent,'10 Oct 2026');
  assert.deepEqual(clone(h.context.ACTIVE_SESSION.bodyweightSnapshot),snapshot);
  h.context.DB.bodyweight.push({date:'2026-10-11',kg:85});
  h.context.setupWorkoutBodyweight();
  assert.equal(date.textContent,'10 Oct 2026'); assert.equal(h.context.ACTIVE_SESSION.bodyweightSnapshot.kg,80);
});

test('unknown, cleared and invalid workout bodyweight never leave a stale or invalid source date',()=>{
  const h=bodyweightHarness({id:'session',start:'2026-10-12',bodyweightSnapshot:snapshot});
  h.context.setupWorkoutBodyweight();
  const date=h.$('#logBodyweightDate'), input=h.$('#logBodyweightInput');
  for(const value of ['', '.', '0', '-80', 'unknown']) {
    input.value=value; input.input();
    assert.equal(date.hidden,true); assert.equal(date.textContent,''); assert.equal(date.dateTime,'');
  }
  for(const sourceDate of ['not-a-date','2026-02-30','2026-02-30T10:00:00Z']) {
    h.context.ACTIVE_SESSION.bodyweightSnapshot={kg:80,date:sourceDate};
    h.context.updateWorkoutBodyweightDate();
    assert.equal(date.hidden,true); assert.equal(date.textContent,'');
  }
  const unknown=bodyweightHarness({id:'session',start:'2026-10-12',bodyweightSnapshot:null});
  unknown.context.setupWorkoutBodyweight();
  assert.equal(unknown.$('#logBodyweightDate').hidden,true);
});

test('date-only workout bodyweight sources keep their calendar day west of UTC',()=>{
  const oldTimezone=process.env.TZ;
  try {
    process.env.TZ='America/Los_Angeles';
    const h=bodyweightHarness({id:'session',start:'2026-10-12',bodyweightSnapshot:{kg:80,date:'2026-07-01'}});
    h.context.setupWorkoutBodyweight();
    assert.equal(h.$('#logBodyweightDate').textContent,'1 Jul 2026');
  } finally {
    if(oldTimezone===undefined) delete process.env.TZ; else process.env.TZ=oldTimezone;
  }
});

test('existing untyped drafts retain legacy assistance while new inputs use the new exercise default',()=>{
  const code=source.slice(source.indexOf('function openLogger('),source.indexOf('  const ex = loggerExercise();',source.indexOf('function openLogger(')))+'\n}';
  const ctx=vm.createContext({document:{activeElement:null}, $:()=>({scrollTop:0}),LOGGER_RETURN_FOCUS:null,CURRENT_LOG_MODE:'external',CURRENT_LOG_EX:null,LOG_SAVING:false,LiftLogExerciseLoad:load,DB:{exercises:{dips:{...strength('weighted'),isAssisted:true}}},ACTIVE_SESSION:{logDrafts:{dips:{rows:[{a:'18',b:''}]}}}});
  vm.runInContext(code,ctx);ctx.openLogger('dips');assert.equal(ctx.CURRENT_LOG_MODE,'assisted');
  ctx.ACTIVE_SESSION.logDrafts.dips.loadType='bodyweight';ctx.openLogger('dips');assert.equal(ctx.CURRENT_LOG_MODE,'bodyweight');
  delete ctx.ACTIVE_SESSION.logDrafts.dips;ctx.openLogger('dips');assert.equal(ctx.CURRENT_LOG_MODE,'weighted');
});

test('logger headings follow saved row modes and reset after mixed-mode rows are removed',()=>{
  const makeNode=()=>({textContent:'',hidden:false,attrs:{},setAttribute(key,value){this.attrs[key]=value;}});
  const first=makeNode(), header={classList:{toggle(name,value){this[name]=value;}},querySelector:()=>first};
  const row=mode=>{const nodes={'.index-num':makeNode(),'.input-val-1':makeNode(),'.input-val-2':makeNode(),'.remove-row':makeNode()};return{dataset:{loadType:mode},nodes,querySelector:key=>nodes[key]||null,prepend(node){nodes['.log-row-mode']=node;node.remove=()=>{delete nodes['.log-row-mode'];};}};};
  let rows=[row('assisted')];
  const context=vm.createContext({CURRENT_LOG_EX:'dips',CURRENT_LOG_MODE:'weighted',CURRENT_LOG_UNIT:'kg',DB:{exercises:{dips:{...strength('weighted'),isAssisted:true}}},LiftLogExerciseLoad:load,$:()=>header,$$:()=>rows,document:{createElement:makeNode}});
  vm.runInContext(source.slice(source.indexOf('function renumberRows()'),source.indexOf('$("#btnAddRow")',source.indexOf('function renumberRows()'))),context);
  context.renumberRows(); assert.equal(first.textContent,'ASSISTANCE (KG)');
  rows.push(row('weighted')); context.renumberRows(); assert.equal(first.textContent,'LOAD (KG)');
  assert.equal(rows[0].nodes['.log-row-mode'].textContent,'Assistance');
  assert.equal(rows[1].nodes['.log-row-mode'].textContent,'Added weight');
  rows.pop(); context.renumberRows(); assert.equal(first.textContent,'ASSISTANCE (KG)');
  assert.equal(rows[0].nodes['.log-row-mode'],undefined);
  rows=[row('bodyweight')]; context.renumberRows(); assert.equal(first.hidden,true);
  assert.equal(header.classList['log-reps-only'],true);
});
