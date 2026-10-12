const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const storage=require('../storage.js');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function database(){return{...clone(storage.BASE_DEFAULTS),exercises:{
 bench:{id:'bench',name:'Bench <press>',type:'strength',muscle:'Chest'},
 curl:{id:'curl',name:'Curl',type:'strength',muscle:'Biceps'},
 squat:{id:'squat',name:'Squat',type:'strength',muscle:'Quads'},
 run:{id:'run',name:'Run',type:'cardio'}},templates:{chest:{id:'chest',name:'Chest & Arms',custom:{keep:['legacy']},exercises:[
 {exId:'bench',sets:4,targetReps:'8–10',unknown:{preserve:true}}, {exId:'curl',sets:3,rest:60}, {exId:'squat',sets:2}
 ]}},sessions:[{id:'old',start:'2026-04-01',entries:{bench:[{w:60,r:8}]}}]};}
function harness(options={}){
 const nodes=new Map(),doc={activeElement:null,events:{},addEventListener(type,fn){this.events[type]=fn;}};
 class Node{
  constructor(){this.children=[];this.selected=new Map();this.dataset={};this.events={};this.attrs={};this.value='';this.textContent='';this.disabled=false;this.isConnected=true;this.scrollTop=0;this.classes=new Set();this.style={setProperty:(key,value)=>{this.style[key]=value;},removeProperty:key=>{delete this.style[key];}};this.classList={add:key=>this.classes.add(key),remove:key=>this.classes.delete(key),contains:key=>this.classes.has(key)};}
  set innerHTML(value){this.html=value;this.children=[];this.selected.clear();}get innerHTML(){return this.html||'';}
  appendChild(node){this.children.push(node);node.parent=this;}
  querySelector(key){if(!this.selected.has(key))this.selected.set(key,new Node());return this.selected.get(key);}
  querySelectorAll(selector){if(selector==='button, input')return [$('#btnCloseTemplateBuilder'),$('#templateBuilderName'),$('#btnAddExToTemplate'),...$('#templateBuilderList').children.flatMap(row=>[row.querySelector('.routine-drag-handle'),row.querySelector('.routine-remove')]),$('#btnSaveTemplateBuilder')];if(selector==='.is-drop-target')return this.children.filter(row=>row.classes.has('is-drop-target'));return[];}
  addEventListener(type,fn){this.events[type]=fn;}
  setAttribute(key,value){this.attrs[key]=value;}
  getClientRects(){return this.classes.has('hidden')?[]:[{}];}
  focus(){doc.activeElement=this;}
  setPointerCapture(id){this.pointerId=id;}
  hasPointerCapture(id){return this.pointerId===id;}
  releasePointerCapture(){this.pointerId=null;}
  getBoundingClientRect(){if(this===$('#templateBuilderBody'))return{top:0,bottom:400};const offset=Number((this.style.transform||'').match(/-?[\d.]+/)?.[0]||0);const top=Number(this.dataset.index||0)*90-$('#templateBuilderBody').scrollTop+offset;return{top,bottom:top+80};}
 }
 const $=key=>{if(!nodes.has(key))nodes.set(key,new Node());return nodes.get(key);};
 doc.querySelector=key=>$(key);doc.createElement=()=>new Node();doc.activeElement=$('#launcher');
 $('#templateBuilderModal').classList.add('hidden');
 const locks=new Set(),notices=[],prompts=[],writes=[];
 let durable=clone(options.db||database()),picker;
 const context=vm.createContext({$,document:doc,DB:clone(durable),STORE_READY:true,STORAGE_ERROR:null,UPDATE_LOCK:false,COMMITTING:false,FINISHING:false,STARTING:false,STORAGE_EPOCH:1,
  LiftLogStorage:storage,copyState:clone,uid:()=> 'newroutine',MUSCLE_COLORS:{Chest:'#E57373',Biceps:'#BA68C8',Quads:'#81C784',Cardio:'#F00'},
  escapeHTML:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  renderRoutineStartCards(){},updateSaveStatus(){},LiftLogUpdates:{notifySafe(){}},showNotice:(...args)=>notices.push(args),
  askConfirm:async(...args)=>{prompts.push(args);return options.confirm?options.confirm(...args):true;},
  LOGGER_SCROLL_LOCK:{acquire:key=>locks.add(key),release:key=>locks.delete(key)},
  openExercisePicker:(select,cancel)=>{picker={select,cancel};},flushSaves:options.flush|| (async()=>true),
  STORE:{saveDB:async(edited,baseline,{epoch})=>{writes.push({edited:clone(edited),baseline:clone(baseline),epoch});if(options.save)return options.save(edited,baseline,{epoch});durable=storage.mergeDB(clone(baseline),clone(edited),durable);return{db:clone(durable),draft:null,epoch,revision:2};}},
  applySnapshot:snapshot=>{context.DB=clone(snapshot.db);context.STORAGE_EPOCH=snapshot.epoch;}
 });
  vm.runInContext(source.slice(source.indexOf('// --- MODAL WORKFLOW HELPERS ---'), source.indexOf('// --- TABS & NAVIGATION ---')), context);
 vm.runInContext(source.slice(source.indexOf('function renderTemplates() {'),source.indexOf('// --- HISTORY & STATS ---')),context);
 return{context,$,doc,locks,prompts,notices,writes,get durable(){return durable;},get picker(){return picker;},save:()=>$('#btnSaveTemplateBuilder').events.click(),open:()=>context.editTemplate('chest'),draft:()=>clone(vm.runInContext('_templateBuilderExercises',context)),setDurable:value=>{durable=clone(value);}};
}

test('routine reordering and a name edit preserve every routine/item field and leave history unchanged',async()=>{
 const h=harness(),before=clone(h.context.DB);h.open();
 h.context.moveTemplateExercise(0,2);h.$('#templateBuilderName').value='Push day';
 assert.deepEqual(h.context.DB,before,'Draft changes do not touch DB.');
 await h.save();
 const saved=h.durable.templates.chest;
 assert.equal(saved.name,'Push day');assert.deepEqual(saved.custom,before.templates.chest.custom);
 assert.deepEqual(saved.exercises,[before.templates.chest.exercises[1],before.templates.chest.exercises[2],before.templates.chest.exercises[0]]);
 assert.deepEqual(h.durable.sessions,before.sessions);assert.deepEqual(h.durable.exercises,before.exercises);
 assert.equal(h.$('#templateBuilderModal').classList.contains('hidden'),true);assert.equal(h.locks.size,0);
});

test('no-op close and no-op Save never prompt, write or alter imported metadata',async()=>{
 const h=harness();h.open();await h.context.closeTemplateBuilder();
 assert.equal(h.prompts.length,0);assert.equal(h.writes.length,0);
 h.open();await h.save();assert.equal(h.prompts.length,0);assert.equal(h.writes.length,0);
 assert.equal(h.doc.activeElement,h.$('#launcher'));
});

test('name-only edits prompt on discard; cancelling preserves the draft and accepting leaves DB unchanged',async()=>{
 let answer=false;const h=harness({confirm:()=>answer});const before=clone(h.context.DB);h.open();h.$('#templateBuilderName').value='Renamed';
 await h.context.closeTemplateBuilder();assert.equal(h.prompts.length,1);assert.equal(h.$('#templateBuilderModal').classList.contains('hidden'),false);
 assert.equal(h.$('#templateBuilderName').value,'Renamed');assert.equal(h.locks.has('routine-builder'),true);
 answer=true;await h.context.closeTemplateBuilder();assert.equal(h.prompts.length,2);assert.equal(h.locks.size,0);assert.deepEqual(h.context.DB,before);assert.equal(h.writes.length,0);
});

test('each exercise removal is confirmed; Cancel preserves the item and Save commits accepted removal only',async()=>{
 let answer=false;const h=harness({confirm:()=>answer});h.open();const original=h.draft();
 await h.context.removeTemplateExercise(1);assert.deepEqual(h.draft(),original);assert.match(h.prompts[0][1],/Curl/);
 answer=true;await h.context.removeTemplateExercise(1);assert.deepEqual(h.draft(),[original[0],original[2]]);assert.equal(h.context.DB.templates.chest.exercises.length,3);
 await h.save();assert.deepEqual(h.durable.templates.chest.exercises,[original[0],original[2]]);
});

test('pending removal suppresses duplicate confirmation, reorder, save and close',async()=>{
 const gate=deferred(),h=harness({confirm:()=>gate.promise});h.open();const pending=h.context.removeTemplateExercise(1);
 await h.context.removeTemplateExercise(0);h.context.moveTemplateExercise(0,2);await h.save();await h.context.closeTemplateBuilder();
 assert.equal(h.prompts.length,1);assert.equal(h.writes.length,0);assert.equal(h.draft()[0].exId,'bench');
 gate.resolve(false);await pending;assert.equal(h.draft().length,3);
});

test('failed Save leaves DB unchanged, retains the editable draft, and releases commit/control locks',async()=>{
 const h=harness({save:async()=>{throw new Error('Disk unavailable');}}),before=clone(h.context.DB);h.open();h.context.moveTemplateExercise(0,2);h.$('#templateBuilderName').value='After';
 await h.save();assert.deepEqual(h.context.DB,before);assert.deepEqual(h.durable,before);assert.equal(h.draft()[2].exId,'bench');
 assert.match(h.$('#templateBuilderError').textContent,/Disk unavailable/);assert.equal(h.$('#templateBuilderModal').classList.contains('hidden'),false);
 assert.equal(h.context.COMMITTING,false);assert.equal(h.$('#btnSaveTemplateBuilder').disabled,false);assert.equal(h.locks.has('routine-builder'),true);
});

test('pending Save blocks duplicate writes, close, removal and new editor launches',async()=>{
 const gate=deferred(),h=harness({save:()=>gate.promise});h.open();h.$('#templateBuilderName').value='After';const pending=h.save();await Promise.resolve();
 await h.save();await h.context.closeTemplateBuilder();await h.context.removeTemplateExercise(0);h.context.openTemplateBuilder();
 assert.equal(h.writes.length,1);assert.equal(h.context.COMMITTING,true);assert.equal(h.prompts.length,0);assert.equal(h.$('#btnSaveTemplateBuilder').disabled,true);
 gate.resolve({db:h.writes[0].edited,epoch:1,draft:null});await pending;assert.equal(h.context.DB.templates.chest.name,'After');assert.equal(h.context.COMMITTING,false);
});

test('routine changed or deleted in local state, or an epoch change, refuses a stale save',async()=>{
 for(const change of [h=>h.context.DB.templates.chest.name='Other',h=>delete h.context.DB.templates.chest,h=>h.context.STORAGE_EPOCH++]){
  const h=harness();h.open();h.$('#templateBuilderName').value='Mine';change(h);await h.save();
  assert.equal(h.writes.length,0);assert.match(h.$('#templateBuilderError').textContent,/changed elsewhere/);assert.equal(h.$('#templateBuilderName').value,'Mine');
 }
});

test('independent external changes are merged while conflicting routine reorders are rejected',async()=>{
 const h=harness();h.open();h.context.moveTemplateExercise(0,2);const external=clone(h.durable);external.templates.other={id:'other',name:'Other',exercises:[{exId:'run'}]};h.setDurable(external);await h.save();assert.deepEqual(h.durable.templates.other,external.templates.other);
 const conflict=harness();conflict.open();conflict.context.moveTemplateExercise(0,2);const changed=clone(conflict.durable);changed.templates.chest.exercises.reverse();conflict.setDurable(changed);await conflict.save();
 assert.deepEqual(conflict.durable,changed);assert.equal(conflict.$('#templateBuilderModal').classList.contains('hidden'),false);assert.match(conflict.$('#templateBuilderError').textContent,/Another open LiftLog/);
});

test('picker add/cancel preserves existing rows and the scroll lock, prevents duplicate exercises',()=>{
 const h=harness();h.open();const before=h.draft();h.$('#btnAddExToTemplate').events.click();assert.equal(h.$('#templateBuilderModal').classList.contains('hidden'),true);
 h.picker.cancel();assert.deepEqual(h.draft(),before);assert.equal(h.locks.has('routine-builder'),true);
 h.$('#btnAddExToTemplate').events.click();h.picker.select('run');assert.deepEqual(h.draft(),[...before,{exId:'run'}]);
 h.$('#btnAddExToTemplate').events.click();h.picker.select('bench');assert.equal(h.draft().length,4);
});

test('keyboard handles reorder to arrows and bounds without changing per-item metadata',()=>{
 const h=harness();h.open();let prevented=0;const initial=h.draft();
 const first=h.$('#templateBuilderList').children[0].querySelector('.routine-drag-handle');first.events.keydown({key:'ArrowUp',preventDefault(){prevented++;}});assert.deepEqual(h.draft(),initial);
 first.events.keydown({key:'End',preventDefault(){prevented++;}});assert.deepEqual(h.draft(),[initial[1],initial[2],initial[0]]);
 assert.equal(h.doc.activeElement,h.$('#templateBuilderList').children[2].querySelector('.routine-drag-handle'));assert.equal(prevented,2);assert.match(h.$('#templateBuilderStatus').textContent,/position 3 of 3/);
});

test('pointer dragging commits only on release; cancellation, lost capture and multi-touch leave order intact',()=>{
 const h=harness();h.open();const original=h.draft();
 const start=()=>{const row=h.$('#templateBuilderList').children[0],handle=row.querySelector('.routine-drag-handle');handle.events.pointerdown({pointerId:1,pointerType:'touch',isPrimary:true,clientY:40,preventDefault(){}});return{row,handle};};
 let drag=start();h.context.moveTemplateDrag({pointerId:1,clientY:225,preventDefault(){}});assert.deepEqual(h.draft(),original);h.context.endTemplateDrag({pointerId:1});assert.deepEqual(h.draft(),[original[1],original[2],original[0]]);
 const ordered=h.draft();drag=start();h.context.moveTemplateDrag({pointerId:1,clientY:230,preventDefault(){}});drag.handle.events.pointercancel();assert.deepEqual(h.draft(),ordered);assert.equal(drag.row.style.transform,undefined);
 drag=start();drag.handle.events.lostpointercapture();h.context.endTemplateDrag({pointerId:1});assert.deepEqual(h.draft(),ordered);
 drag=start();h.doc.events.pointerdown({pointerId:2});h.context.endTemplateDrag({pointerId:1});assert.deepEqual(h.draft(),ordered);
});

test('Library routine cards have escaped exercise previews, muscle colours and named edit/delete controls',()=>{
 const h=harness();h.context.renderTemplates();const li=h.$('#templateList').children[0];
 assert.match(li.innerHTML,/Bench &lt;press&gt;/);assert.doesNotMatch(li.innerHTML,/<press>/);assert.match(li.innerHTML,/--routine-muscle:#E57373/);assert.match(li.innerHTML,/EDIT ROUTINE/);assert.match(li.innerHTML,/aria-label="Edit Chest &amp; Arms"/);
 li.querySelector('.routine-edit').events.click();assert.equal(h.$('#templateBuilderModal').classList.contains('hidden'),false);
});

test('routine dialog keeps Save outside the scrolling body and supports a named close control',()=>{
 const editor=html.slice(html.indexOf('<div id="templateBuilderModal"'),html.indexOf('<div id="dayModal"'));
 assert.match(editor,/role="dialog" aria-modal="true" aria-labelledby="templateBuilderTitle"/);assert.match(editor,/aria-label="Close routine editor"/);
 assert.match(editor.slice(editor.indexOf('<footer')),/id="btnSaveTemplateBuilder"/);assert.match(editor,/id="templateBuilderError" role="alert"/);
});


test('fresh routine opens start at their heading, while picker cancellation preserves the source editor scroll',async()=>{
 const h=harness(),before=clone(h.context.DB);
 h.$('#templateBuilderBody').scrollTop=270;h.open();assert.equal(h.$('#templateBuilderBody').scrollTop,0);
 h.$('#templateBuilderBody').scrollTop=150;h.$('#btnAddExToTemplate').events.click();h.picker.cancel();
 assert.equal(h.$('#templateBuilderBody').scrollTop,150);assert.equal(h.doc.activeElement,h.$('#btnAddExToTemplate'));
 await h.context.closeTemplateBuilder();h.$('#templateBuilderBody').scrollTop=270;h.open();
 assert.equal(h.$('#templateBuilderBody').scrollTop,0);assert.deepEqual(h.context.DB,before);
});

test('correcting routine name or exercises clears stale validation while preserving failed-save errors',async()=>{
 const h=harness();h.context.openTemplateBuilder();const before=clone(h.context.DB);
 await h.save();assert.equal(h.$('#templateBuilderError').textContent,'Enter a routine name.');
 h.$('#templateBuilderName').value='Audit routine';h.$('#templateBuilderName').events.input();
 assert.equal(h.$('#templateBuilderError').textContent,'');
 await h.save();assert.equal(h.$('#templateBuilderError').textContent,'Add at least one exercise.');
 h.$('#btnAddExToTemplate').events.click();h.picker.select('squat');
 assert.equal(h.$('#templateBuilderError').textContent,'');assert.deepEqual(h.context.DB,before);assert.equal(h.writes.length,0);
 h.$('#templateBuilderError').textContent='Enter a routine name.';
 h.$('#btnAddExToTemplate').events.click();h.picker.select('bench');
 h.$('#templateBuilderError').textContent='Add at least one exercise.';h.context.moveTemplateExercise(0,1);
 assert.equal(h.$('#templateBuilderError').textContent,'');
 h.$('#templateBuilderError').textContent='Add at least one exercise.';await h.context.removeTemplateExercise(0);
 assert.equal(h.$('#templateBuilderError').textContent,'');
 h.$('#templateBuilderError').textContent='Disk unavailable';h.$('#templateBuilderName').events.input();
 h.$('#btnAddExToTemplate').events.click();h.picker.select('curl');h.context.moveTemplateExercise(0,1);await h.context.removeTemplateExercise(0);
 assert.equal(h.$('#templateBuilderError').textContent,'Disk unavailable');assert.deepEqual(h.context.DB,before);
});
