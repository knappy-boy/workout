const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const clone = value => JSON.parse(JSON.stringify(value));
const helpers = section('// --- MODAL WORKFLOW HELPERS ---', '// --- TABS & NAVIGATION ---');

function dom() {
  const nodes = new Map(), scrolls = [];
  const style = () => ({values: new Map(), getPropertyValue(key) {return this.values.get(key) || '';}, getPropertyPriority() {return '';},
    setProperty(key, value) {this.values.set(key, value);}, removeProperty(key) {this.values.delete(key);}});
  const document = {activeElement:null, body:{style:style()}, documentElement:{style:style()}};
  class Node {
    constructor() {this.children=[];this.attrs={};this.handlers={};this.value='';this.textContent='';this.scrollTop=0;this.scrollLeft=0;this.disabled=false;this.hidden=false;this.isConnected=true;this.dataset={};this.style=style();this.classes=new Set();this.selected=new Map();
      this.classList={add:key=>this.classes.add(key),remove:key=>this.classes.delete(key),contains:key=>this.classes.has(key),toggle:(key,on)=>{const yes=on===undefined?!this.classes.has(key):on;yes?this.classes.add(key):this.classes.delete(key);return yes;}};}
    set innerHTML(value) {this.html=value;this.children=[];}
    get innerHTML() {return this.html || '';}
    get firstChild() {return this.children[0] || null;}
    appendChild(node) {if(node.parent){node.parent.children.splice(node.parent.children.indexOf(node),1);}this.children.push(node);node.parent=this;return node;}
    replaceChildren(...children) {this.children=[];children.forEach(child=>this.appendChild(child));}
    querySelector(key) {if(!this.selected.has(key))this.selected.set(key,new Node());return this.selected.get(key);}
    querySelectorAll() {return this.controls || [];}
    addEventListener(type, fn) {this.handlers[type]=fn;}
    setAttribute(key, value) {this.attrs[key]=String(value);}
    getClientRects() {return this.hidden||this.classes.has('hidden')||!this.isConnected?[]:[{}];}
    focus() {document.activeElement=this;}
    click() {return (this.handlers.click||this.onclick)?.({target:this});}
  }
  const $=key=>{if(!nodes.has(key))nodes.set(key,new Node());return nodes.get(key);};
  document.querySelector=key=>nodes.get(key)||null;document.createElement=()=>new Node();
  const window={scrollX:0,scrollY:300,scrollTo:(...args)=>scrolls.push(args)};
  return {$,document,window,nodes,scrolls,Node};
}
function key(node, value, shiftKey=false) {
  const event={key:value,shiftKey,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};
  node.handlers.keydown(event);return event;
}

test('only a successful new workout resets page scroll, never a failed or already-active start',async()=>{
  for(const success of [true,false]) {
    const h=dom(),db={exercises:{bench:{id:'bench'}},bodyweight:[]},saved=[];
    const context=vm.createContext({...h,DB:db,ACTIVE_SESSION:null,STORE_READY:true,STORAGE_ERROR:null,UPDATE_LOCK:false,FINISHING:false,STARTING:false,
      uid:()=> 'new',LiftLogExerciseLoad:require('../exercise-load.js'),refreshSavedData:async()=>{},stopTimer(){},renderWorkoutTab(){},showNotice(){},
      saveDraft:async()=>{saved.push(clone(context.ACTIVE_SESSION));return success;}});
    vm.runInContext(section('async function startWorkout(', '// Active handle drag state'),context);
    await context.startWorkout({id:'routine',name:'Legs',exercises:[{exId:'bench'}]});
    assert.equal(saved.length,1);assert.deepEqual(saved[0].order,['bench']);
    assert.equal(h.scrolls.length,success?1:0);
    if(success) assert.deepEqual(clone(h.scrolls[0]),[{top:0,left:0,behavior:'instant'}]);
    h.scrolls.length=0;await context.startWorkout();assert.equal(h.scrolls.length,0);assert.equal(saved.length,1);
  }
});

function loggerHarness({success=true}={}) {
  const h=dom(),modal=h.$('#logModal');modal.classList.add('hidden');
  const close=h.$('#logModalClose'),save=h.$('#btnSaveLog');modal.controls=[close,h.$('#logNotes'),save];
  const origin=h.$('#origin');origin.focus();
  const DB={exercises:{bench:{id:'bench',name:'Bench',type:'strength',muscle:'Chest'},press:{id:'press',name:'Press',type:'strength',muscle:'Chest'}},sessions:[],templates:{},bodyweight:[]};
  const active={id:'active',start:'2026-10-12T10:00:00Z',order:['bench'],entries:{},exerciseNotes:{},logDrafts:{}};
  let rows=[],picker;
  const context=vm.createContext({...h,DB,ACTIVE_SESSION:active,LiftLogLogging:require('../logging.js'),LiftLogExerciseLoad:require('../exercise-load.js'),LiftLogDates:require('../dates.js'),LiftLogStorage:require('../storage.js'),
    LiftLogUpdates:{notifySafe(){}},getWeightUnit:()=> 'kg',MUSCLE_COLORS:{Chest:'#E57373',Other:'#78909C'},updateSaveStatus(){},
    COMMITTING:false,FINISHING:false,UPDATE_LOCK:false,STARTING:false,STORE_READY:true,STORAGE_ERROR:null,STORAGE_EPOCH:1,
    $$:selector=>selector==='#logRows .log-row'?rows:modal.controls,saveDraft:async()=>success,renderActiveSession(){},copyState:clone,askConfirm:async()=>false,
    openExercisePicker:(choose,cancel,options)=>{picker={choose,cancel,options};}});
  vm.runInContext(helpers+section('let CURRENT_LOG_EX = null;', '// --- TEMPLATES ---'),context);
  Object.defineProperty(h.$('#logRows'),'innerHTML',{set(){rows=[];}});
  context.addLogRow=(exercise,data={})=>{
    const row=new h.Node();row._sourceRow=data||{};
    row.querySelector('.input-val-1').value=data?.a||'';row.querySelector('.input-val-2').value=data?.b||'';rows.push(row);
  };
  return {...h,context,modal,origin,close,save,rows:()=>rows,picker:()=>picker};
}

test('logger opens at its heading, contains focus, and Escape preserves partial edits before restoring its launcher',async()=>{
  const h=loggerHarness();h.$('#logModal .drawer-body').scrollTop=260;h.context.openLogger('bench');
  assert.equal(h.$('#logModal .drawer-body').scrollTop,0);assert.equal(h.document.activeElement,h.$('#logModalTitle'));
  assert.equal(h.$('#logModalTitle').attrs.tabindex,'-1');assert.equal(h.document.body.style.getPropertyValue('position'),'fixed');
  key(h.modal,'Tab');assert.equal(h.document.activeElement,h.close);
  key(h.modal,'Tab',true);assert.equal(h.document.activeElement,h.save);
  h.rows()[0].querySelector('.input-val-1').value='45.';
  key(h.modal,'Escape');await new Promise(setImmediate);
  assert.equal(h.modal.classList.contains('hidden'),true);assert.equal(h.document.activeElement,h.origin);
  assert.equal(h.context.ACTIVE_SESSION.logDrafts.bench.rows[0].a,'45.');
  assert.equal(h.document.body.style.getPropertyValue('position'),'');
});

test('failed logger close keeps focus and scroll lock; successful Save restores the replacement workout launcher',async()=>{
  const failed=loggerHarness({success:false});failed.context.openLogger('bench');await failed.context.closeLogger();
  assert.equal(failed.modal.classList.contains('hidden'),false);assert.equal(failed.document.activeElement,failed.$('#logModalTitle'));
  assert.equal(failed.document.body.style.getPropertyValue('position'),'fixed');
  const h=loggerHarness();h.context.openLogger('bench');
  const replacement=h.$('#activeExerciseList [data-exercise-id="bench"] .exercise-open');
  h.rows()[0].querySelector('.input-val-1').value='45';h.rows()[0].querySelector('.input-val-2').value='8';
  h.context.renderActiveSession=()=>{h.origin.isConnected=false;};await h.context.saveLog();
  assert.equal(h.document.activeElement,replacement);assert.equal(h.context.ACTIVE_SESSION.entries.bench[0].r,'8');
});

test('cancelled exercise swap restores the source logger scroll while a replacement starts from its heading',async()=>{
  const h=loggerHarness();h.context.openLogger('bench');h.$('#logModal .drawer-body').scrollTop=180;
  await h.context.swapLoggerExercise();await h.picker().cancel();
  assert.equal(h.$('#logModal .drawer-body').scrollTop,180);assert.equal(h.document.activeElement,h.$('#btnSwapLogExercise'));
  assert.equal(h.document.body.style.getPropertyValue('position'),'fixed');
  await h.context.swapLoggerExercise();await h.picker().choose('press');
  assert.equal(h.$('#logModal .drawer-body').scrollTop,0);assert.equal(h.document.activeElement,h.close);
  assert.deepEqual(clone(h.context.ACTIVE_SESSION.order),['press']);
});

test('calendar details use recorded load labels, fixed scroll locking and modal keyboard focus without editing history',()=>{
  const h=dom(),origin=h.$('#calendarDay');origin.focus();const close=h.$('#btnCloseDayModal');h.$('#dayModal').controls=[close];
  const workouts=[{entries:{dips:[{w:0,r:8,loadType:'bodyweight'}],pullup:[{w:18,r:8,loadType:'assisted'}],weighted:[{w:10,r:8,loadType:'weighted'}]}}];
  const before=clone(workouts),DB={exercises:Object.fromEntries(['dips','pullup','weighted'].map(id=>[id,{id,name:id,type:'strength',muscle:'Back'}]))};
  const context=vm.createContext({...h,DB,LiftLogDates:require('../dates.js'),LiftLogLogging:require('../logging.js'),LiftLogUpdates:{notifySafe(){}},MUSCLE_COLORS:{Back:'#64B5F6'},getWeightUnit:()=> 'kg',escapeHTML:String,
    LOGGER_SCROLL_LOCK:require('../logging.js').createScrollLock(h.window,h.document)});
  vm.runInContext(helpers+section('function showDayDetails(', '$("#btnPrevMonth").addEventListener'),context);
  h.$('#dayModalContent').scrollTop=190;h.$('#previousFocus').focus();context.showDayDetails('2026-10-12',workouts,origin);
  assert.equal(h.document.activeElement,h.$('#dayModalTitle'));assert.equal(h.$('#dayModalContent').scrollTop,0);
  assert.equal(h.$('#dayModal .day-modal-box').attrs.role,'dialog');assert.equal(h.document.body.style.getPropertyValue('position'),'fixed');
  assert.match(h.$('#dayModalContent').innerHTML,/Bodyweight × 8/);assert.match(h.$('#dayModalContent').innerHTML,/18kg assistance × 8/);assert.match(h.$('#dayModalContent').innerHTML,/10kg added × 8/);
  key(h.$('#dayModal'),'Tab',true);assert.equal(h.document.activeElement,close);
  key(h.$('#dayModal'),'Escape');assert.equal(h.document.activeElement,origin);assert.equal(h.document.body.style.getPropertyValue('position'),'');assert.deepEqual(workouts,before);
});

test('Library filtering preserves button identity, focus and horizontal scroll through filters and text searches',()=>{
  const h=dom(),context=vm.createContext({...h,_libraryFilter:'All',MUSCLE_GROUPS:['Chest','Back'],MUSCLE_COLORS:{Chest:'#E57373',Back:'#64B5F6'}});
  vm.runInContext(section('function renderLibraryTabs()', '// Library search listener'),context);
  context.renderExerciseLibrary=()=>context.renderLibraryTabs();context.renderLibraryTabs();
  const buttons=[...h.$('#libraryTabs').children],chest=buttons[1];chest.focus();h.$('#libraryTabs').scrollLeft=55;chest.click();
  assert.equal(h.document.activeElement,chest);assert.equal(h.$('#libraryTabs').scrollLeft,55);assert.equal(chest.attrs['aria-pressed'],'true');
  for(let i=0;i<20;i++)context.renderExerciseLibrary();assert.deepEqual(h.$('#libraryTabs').children,buttons);
});

test('Data collapse removes hidden actions from keyboard navigation and accessibility; Enter and Space toggle the same controls',()=>{
  const h=dom();h.$('#dataContent').classList.add('collapsed');
  const context=vm.createContext(h);vm.runInContext(section('// Data section toggle in settings', '// --- SETTINGS TAB ---'),context);
  assert.equal(h.$('#dataContent').inert,true);assert.equal(h.$('#dataContent').attrs['aria-hidden'],'true');assert.equal(h.$('#dataHeader').attrs['aria-expanded'],'false');
  assert.equal(h.$('#dataHeader').attrs.role,'button');assert.equal(h.$('#dataHeader').attrs.tabindex,'0');
  key(h.$('#dataHeader'),'Enter');assert.equal(h.$('#dataContent').inert,false);assert.equal(h.$('#dataHeader').attrs['aria-expanded'],'true');
  key(h.$('#dataHeader'),' ');assert.equal(h.$('#dataContent').inert,true);assert.equal(h.$('#dataHeader').attrs['aria-expanded'],'false');
  const action=h.$('#backup'),handler=()=>{};action.addEventListener('click',handler);h.$('#dataContent').appendChild(action);
  vm.runInContext(section('const dataActions = document.createElement', '$("#btnRetrySave").addEventListener'),context);
  assert.equal(h.$('#dataContent').children.length,1);assert.equal(h.$('#dataContent').children[0].id,'dataActions');assert.equal(h.$('#dataContent').children[0].children[0],action);assert.equal(action.handlers.click,handler);
});
