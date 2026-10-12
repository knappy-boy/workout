const test=require('node:test');
const assert=require('node:assert/strict');
const {bind}=require('../tap-feedback.js');
function setup(){
  let time=0,next=1;const timers=new Map(),events=new Map(),classes=new Set();
  const card={disabled:false,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},closest:()=>card};
  const doc={visibilityState:'visible',addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
  const env={performance:{now:()=>time},setTimeout:(fn,delay)=>{const id=next++;timers.set(id,{fn,at:time+delay});return id;},clearTimeout:id=>timers.delete(id)};
  const instance=bind(env,doc);
  function fire(name,options={}){const event={target:card,pointerId:1,pointerType:'touch',isPrimary:true,button:0,clientX:10,clientY:10,detail:1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...options};events.get(name)?.(event);return event;}
  function advance(ms){time+=ms;for(const [id,timer]of [...timers])if(timer.at<=time){timers.delete(id);timer.fn();}}
  return {classes,timers,fire,advance,instance,doc};
}
test('touch scrolling before the hold threshold never flashes the routine or starts it',()=>{const s=setup();s.fire('pointerdown');assert.equal(s.classes.size,0);s.fire('pointermove',{clientY:35});s.advance(200);s.fire('pointerup',{clientY:35});assert.equal(s.classes.size,0);const click=s.fire('click');assert.equal(click.prevented,true);assert.equal(click.stopped,true);});
test('stationary hold and quick taps get bounded feedback',()=>{const s=setup();s.fire('pointerdown');s.advance(141);assert.ok(s.classes.has('is-pressing'));s.fire('pointerup');s.advance(161);assert.equal(s.classes.size,0);s.fire('pointerdown');s.fire('pointerup');assert.ok(s.classes.has('is-pressing'));assert.equal(s.fire('click').prevented,undefined);s.advance(161);assert.equal(s.classes.size,0);});
test('scroll, cancellation and another finger clear held feedback',()=>{for(const event of ['scroll','pointercancel','pointerdown']){const s=setup();s.fire('pointerdown');s.advance(141);s.fire(event,event==='pointerdown'?{pointerId:2,isPrimary:false}:{});assert.equal(s.classes.size,0);s.advance(500);assert.equal(s.classes.size,0);}});
test('keyboard activation and a subsequent deliberate tap remain available after scrolling',()=>{const s=setup();s.fire('pointerdown');s.fire('scroll');assert.equal(s.fire('click',{detail:0}).prevented,undefined);s.fire('pointerdown');s.fire('pointerup');assert.equal(s.fire('click').prevented,undefined);});
test('up displacement cancels even without move events; teardown clears feedback/listeners',()=>{const s=setup();s.fire('pointerdown');s.fire('pointerup',{clientX:25});assert.equal(s.classes.size,0);assert.equal(s.fire('click').prevented,true);s.fire('pointerdown');s.advance(150);s.instance.dispose();assert.equal(s.classes.size,0);assert.equal(s.timers.size,0);});

test('long cancelled drags stay blocked until their terminal pointer event',()=>{const s=setup();s.fire('pointerdown');s.fire('pointermove',{clientY:50});s.advance(2500);s.fire('pointerup',{clientY:50});assert.equal(s.fire('click').prevented,true);s.fire('pointerdown');s.fire('pointerup');assert.equal(s.fire('click').prevented,undefined);});
test('multitouch suppression lasts through the last finger leaving',()=>{const s=setup();s.fire('pointerdown');s.fire('pointerdown',{pointerId:2,isPrimary:false});s.advance(1200);s.fire('pointerup');s.advance(1200);s.fire('pointerup',{pointerId:2,isPrimary:false});assert.equal(s.fire('click').prevented,true);});
