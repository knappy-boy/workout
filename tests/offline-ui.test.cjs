const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function harness() {
  const nodes = new Map();
  const $ = id => {if(!nodes.has(id)) nodes.set(id,{textContent:'',hidden:false,disabled:false,value:0,max:1,events:{},removeAttribute(name){delete this[name];},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(id);};
  let time=1000,intervals=0,retries=0;
  const context=vm.createContext({$,navigator:{onLine:true,serviceWorker:{controller:{}}},Date:{now:()=>time},setInterval(){intervals++;return 1;},clearInterval(){intervals--;},updateReliabilityStrip(){},LiftLogUpdates:{check(){retries++;return Promise.resolve();}}});
  vm.runInContext(source.slice(source.indexOf('// Offline app installation is independent'),source.indexOf('STORE.subscribe(',source.indexOf('// Offline app installation is independent'))),context);
  return {$,context,setTime(value){time=value;},get intervals(){return intervals;},get retries(){return retries;}};
}
test('a failed first install is explicit even when a worker controls the page, with an actionable retry',()=>{
 const h=harness();h.context.receiveOfflineStatus({state:'failed',stage:'error',offlineReady:false,errorCode:'http',retryable:true});
 assert.match(h.$('#offlineStatus').textContent,/not ready.*app server/);assert.equal(h.$('#offlineProgress').hidden,true);assert.equal(h.$('#btnRetryOffline').hidden,false);assert.equal(h.$('#btnRetryOffline').disabled,false);
 h.$('#btnRetryOffline').events.click();assert.equal(h.retries,1);assert.match(h.$('#updateStatus').textContent,/needs attention/);
});
test('phase progress shows measured files, bytes and elapsed time without an invented ETA',()=>{
 const h=harness();h.context.receiveOfflineStatus({state:'checking',stage:'checking',completed:1,total:16,bytes:1024,offlineReady:false});h.setTime(4000);
 h.context.receiveOfflineStatus({state:'downloading',stage:'downloading',completed:4,total:16,bytes:61440,offlineReady:false});
 assert.equal(h.$('#offlineProgress').max,16);assert.equal(h.$('#offlineProgress').value,4);assert.match(h.$('#offlineProgressDetail').textContent,/4 of 16.*60 KB.*3 seconds elapsed/);assert.equal(h.intervals,1);
 h.context.receiveOfflineStatus({state:'current',stage:'ready',offlineReady:true});assert.equal(h.intervals,0);assert.equal(h.$('#offlineProgress').hidden,true);assert.equal(h.$('#offlineHelp').hidden,true);assert.equal(h.$('#btnRetryOffline').hidden,true);
});
test('being offline and a verified cached app are separate facts',()=>{
 const h=harness();h.context.navigator.onLine=false;
 h.context.receiveOfflineStatus({state:'failed',stage:'error',offlineReady:false,errorCode:'network',retryable:true});assert.match(h.$('#offlineStatus').textContent,/not ready.*Reconnect/);assert.equal(h.$('#btnRetryOffline').disabled,true);
 h.context.receiveOfflineStatus({state:'deferred',stage:'error',offlineReady:true,retryable:true});assert.match(h.$('#offlineStatus').textContent,/Offline app ready.*without an internet/);assert.equal(h.$('#offlineProgress').hidden,true);
});
test('a deferred update preserves clear ready status and explains an active-workout wait',()=>{
 const h=harness();h.context.receiveOfflineStatus({state:'deferred',stage:'error',offlineReady:true,errorCode:'timeout',retryable:true});assert.match(h.$('#offlineStatus').textContent,/Offline app ready.*update could not/);
 h.context.receiveOfflineStatus({state:'waiting',stage:'waiting',offlineReady:false});assert.match(h.$('#offlineStatus').textContent,/current workout/);assert.equal(h.$('#offlineProgress').hidden,true);
});
