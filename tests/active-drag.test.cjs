const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const pointer = (pointerId = 7, clientX = 290, clientY = 80, extras = {}) => ({pointerId, clientX, clientY, pointerType:'touch', button:0, isPrimary:true, preventDefault(){this.prevented=true;}, ...extras});

function harness() {
  const listeners = new Map(), windowListeners = new Map(), clones = new Set(), scrolls=[];
  const list={children:[]};
  const makeElement = index => {
    const classes = new Set();let captured=null;
    return {
      dataset: {idx:String(index)}, style:{}, parentElement:list, attrs:{},
      classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key)},
      getBoundingClientRect:()=>({left:10,top:30+index*100,width:300,height:90}),
      closest(){return this;}, querySelector(){return this.handle;},
      cloneNode:()=>makeElement(index),remove(){clones.delete(this);},
      setAttribute(key,value){this.attrs[key]=value;},
      setPointerCapture(id){captured=id;},hasPointerCapture:id=>captured===id,releasePointerCapture(){captured=null;},
      focus(options){this.focused=options;}
    };
  };
  const rows=[0,1,2].map(index=>{const row=makeElement(index);row.handle=makeElement(index);return row;});list.children=rows;
  let target=rows[2],renders=0;
  const document={hidden:false,body:{appendChild:clone=>clones.add(clone)},addEventListener:(type,fn)=>listeners.set(type,fn),querySelectorAll:()=>rows.filter(row=>row.classList.contains('drag-over')),elementFromPoint:()=>target};
  const context=vm.createContext({document,window:{innerHeight:844,scrollBy:options=>scrolls.push(options),addEventListener:(type,fn)=>windowListeners.set(type,fn)},$ :()=>list,
    ACTIVE_SESSION:{id:'active',start:'2026-10-12T12:00:00Z',order:['bench','curl','press'],entries:{bench:[{w:45,r:8}]},logDrafts:{curl:{rows:[{a:'20',b:''}]}},exerciseNotes:{bench:'Keep notes'}},
    COMMITTING:false,FINISHING:false,UPDATE_LOCK:false,STARTING:false,STORE_READY:true,STORAGE_ERROR:null,STORAGE_EPOCH:1,renderActiveSession(){renders++;}});
  vm.runInContext(source.slice(source.indexOf('// Active handle drag state'),source.indexOf('function renderActiveSession()')),context);
  vm.runInContext(source.slice(source.indexOf('function activeDragBlocked('),source.indexOf('$("#btnAddExToWorkout")',source.indexOf('function activeDragBlocked('))),context);
  return {context,rows,clones,scrolls,list,start:(event,index=0)=>context.startActivePointerDrag(event,index,rows[index],rows[index].handle),dispatch:(type,event)=>listeners.get(type)(event),blur:()=>windowListeners.get('blur')(),resize:()=>windowListeners.get('resize')(),setTarget:value=>{target=value;},order:()=>Array.from(context.ACTIVE_SESSION.order),get renders(){return renders;}};
}

test('mouse, pen and touch handle drags change only the order on the owning pointer release',()=>{
 for(const pointerType of ['mouse','pen','touch']){
  const h=harness(),data=JSON.stringify({entries:h.context.ACTIVE_SESSION.entries,notes:h.context.ACTIVE_SESSION.exerciseNotes,drafts:h.context.ACTIVE_SESSION.logDrafts});
  h.start(pointer(7,290,80,{pointerType}));assert.equal(h.clones.size,0);assert.equal(h.rows[0].handle.hasPointerCapture(7),true);
  h.dispatch('pointermove',pointer(7,290,82,{pointerType}));assert.equal(h.clones.size,0);
  h.dispatch('pointermove',pointer(7,290,280,{pointerType}));assert.equal(h.clones.size,1);assert.equal(h.rows[2].classList.contains('drag-over'),true);
  assert.deepEqual(h.order(),['bench','curl','press']);assert.equal(h.renders,0);
  const clone=[...h.clones][0];assert.equal(clone.inert,true);assert.equal(clone.attrs['aria-hidden'],'true');assert.equal(clone.style.pointerEvents,'none');
  h.dispatch('pointerup',pointer(7,290,280,{pointerType}));
  assert.deepEqual(h.order(),['curl','press','bench']);assert.equal(h.renders,1);assert.equal(h.clones.size,0);assert.equal(h.rows[0].handle.hasPointerCapture(7),false);
  assert.equal(JSON.stringify({entries:h.context.ACTIVE_SESSION.entries,notes:h.context.ACTIVE_SESSION.exerciseNotes,drafts:h.context.ACTIVE_SESSION.logDrafts}),data);
 }
});

test('unrelated pointer movement, release or capture loss cannot commit or dismiss the owner',()=>{
 const h=harness();h.start(pointer());h.dispatch('pointermove',pointer(7,290,280));
 h.dispatch('pointermove',pointer(99,20,20));h.dispatch('pointerup',pointer(99));h.context.cancelActivePointerDrag(pointer(99));
 assert.equal(h.clones.size,1);assert.deepEqual(h.order(),['bench','curl','press']);assert.equal(h.renders,0);
 h.dispatch('pointerup',pointer(7,290,280));assert.deepEqual(h.order(),['curl','press','bench']);
});

test('second handle or other-finger presses cancel without transferring ownership, then a fresh gesture works',()=>{
 for(const second of [h=>h.start(pointer(99,290,180,{isPrimary:false}),1),h=>h.dispatch('pointerdown',pointer(99,20,20,{isPrimary:false}))]){
  const h=harness();h.start(pointer());h.dispatch('pointermove',pointer(7,290,280));second(h);
  assert.equal(h.clones.size,0);h.dispatch('pointerup',pointer(99));h.dispatch('pointerup',pointer());assert.deepEqual(h.order(),['bench','curl','press']);assert.equal(h.renders,0);
  h.start(pointer(101,290,180),1);h.dispatch('pointermove',pointer(101,290,280));h.dispatch('pointerup',pointer(101,290,280));assert.deepEqual(h.order(),['bench','press','curl']);
 }
});

test('cancellation, lost capture, blur, resize, hidden page and outside-list drops clean up without reordering',()=>{
 for(const stop of [h=>h.dispatch('pointercancel',pointer()),h=>h.context.cancelActivePointerDrag(pointer()),h=>h.blur(),h=>h.resize(),h=>{h.context.document.hidden=true;h.dispatch('visibilitychange',{});},h=>{h.setTarget(null);h.dispatch('pointerup',pointer(7,10,800));},h=>{const outside={dataset:{idx:'2'},parentElement:{},closest(){return this;}};h.setTarget(outside);h.dispatch('pointerup',pointer(7,20,20));}]){
  const h=harness();h.start(pointer());h.dispatch('pointermove',pointer(7,290,280));stop(h);
  assert.equal(h.clones.size,0);assert.ok(h.rows.every(row=>!row.classList.contains('dragging')&&!row.classList.contains('drag-over')));assert.deepEqual(h.order(),['bench','curl','press']);assert.equal(h.renders,0);assert.equal(h.rows[0].handle.hasPointerCapture(7),false);
 }
});

test('workout replacement, order changes, generation changes or commit locks cancel late drags',()=>{
 for(const change of [h=>{h.context.ACTIVE_SESSION.id='other';},h=>{h.context.ACTIVE_SESSION.order.reverse();},h=>{h.context.STORAGE_EPOCH++;},...['COMMITTING','FINISHING','UPDATE_LOCK','STARTING'].map(key=>h=>{h.context[key]=true;}),h=>{h.context.STORE_READY=false;},h=>{h.context.STORAGE_ERROR=new Error('Unavailable');}]){
  const h=harness();h.start(pointer());h.dispatch('pointermove',pointer(7,290,280));change(h);const before=h.order();h.dispatch('pointerup',pointer(7,290,280));
  assert.equal(h.clones.size,0);assert.deepEqual(h.order(),before);assert.equal(h.renders,0);
 }
});

test('a tap, right mouse button, non-primary press or single-exercise workout cannot reorder',()=>{
 const h=harness();h.start(pointer());h.dispatch('pointerup',pointer());assert.equal(h.renders,0);assert.equal(h.clones.size,0);
 for(const event of [pointer(7,290,80,{pointerType:'mouse',button:2}),pointer(7,290,80,{isPrimary:false})]){h.start(event);h.dispatch('pointermove',pointer(7,290,280));assert.equal(h.clones.size,0);}
 h.context.ACTIVE_SESSION.order=['bench'];h.start(pointer());h.dispatch('pointermove',pointer(7,290,280));assert.equal(h.clones.size,0);
});

test('owned pointer movement can scroll a long workout at viewport edges and clears old target marks',()=>{
 const h=harness();h.start(pointer());h.dispatch('pointermove',pointer(7,290,810));assert.deepEqual(JSON.parse(JSON.stringify(h.scrolls)),[{top:14,behavior:'instant'}]);
 h.setTarget(h.rows[1]);h.dispatch('pointermove',pointer(7,290,50));assert.equal(h.rows[2].classList.contains('drag-over'),false);assert.equal(h.rows[1].classList.contains('drag-over'),true);assert.equal(h.scrolls[1].top,-14);
 h.context.clearActiveDrag();assert.equal(h.clones.size,0);
});
