// THROWAWAY RESEARCH, NOT AN INSTALLED PLUGIN. Native DSH modules; only LLM/producer work is controlled.
// node prototypes/turn-stopping-wait/native-experiment.mjs /path/to/@deepseek-ai
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const root = process.argv[2];
if (!root) throw new Error('Supply the installed @deepseek-ai directory; no profile is loaded.');
const req = createRequire(resolve(root, 'dsh-agent-loop/package.json'));
const load = async name => import(pathToFileURL(req.resolve('@deepseek-ai/' + name)).href);
const { Context } = await load('cordis');
const llm = await load('dsh-llm');
const results = [];
const tick = async () => { for(let i=0;i<8;i++) await new Promise(setImmediate); };
const bounded = (promise,label) => {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Experiment timeout: '+label)),2000);})]).finally(()=>clearTimeout(timer));
};
function message(text,kind='user') {return llm.createUserMessage({content:[{type:'text',text}],source:{kind}});}
function snapshot(h) {
  const goal = h.ctx.goals.get(h.agent);
  return {status:h.agent.status,calls:h.calls.filter(c=>c.main).length,holds:h.gate?.holds.size??0,
    goal:goal&&{phase:goal.phase,activation:goal.activation,revision:goal.revision,roundsStarted:goal.roundsStarted,objective:goal.objective},
    turnEnds:h.events.filter(e=>e.type==='turn/end').length,
    admitted:(()=>{let turn;const admitted=[];for(const e of h.events){if(e.type==='turn/start')turn=e.data.turn;if(e.type==='user/message')admitted.push({turn,kind:e.data.source.kind,round:e.data.source.round,revision:e.data.source.revision});}return admitted;})(),
    releases:h.releases.map(r=>r.reason),toolResults:h.toolResults.map(r=>({name:r.name,isError:r.isError,code:r.code}))};
}
async function runtime({gate=true,releaseOnGoalChange=true,observeAbort=true,finishGuard=true,children=false,onCall}={}) {
  const ctx = new Context();
  const h = {ctx,calls:[],events:[],toolResults:[],releases:[],jobs:[],waiters:[],hookEntries:0,onCall};
  h.changed = () => {for(const w of [...h.waiters]) if(w.predicate()){h.waiters.splice(h.waiters.indexOf(w),1);w.resolve();}};
  h.until = (predicate,label) => {if(predicate())return Promise.resolve(); const d=Promise.withResolvers();h.waiters.push({predicate,resolve:d.resolve});return bounded(d.promise,label);};
  for(const name of ['dsh-session','dsh-session-projection','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-goal','dsh-jobs-local'])await ctx.plugin((await load(name)).default);
  if(children){
    h.scratch=await mkdtemp(join(tmpdir(),'dsh-wait-research-'));
    await ctx.plugin((await load('dsh-session-persistence-jsonl')).default,{root:join(h.scratch,'sessions'),compression:'none'});
    await ctx.plugin((await load('dsh-subagent')).default);
    await ctx.plugin(await load('dsh-subagent-spawn-in-process'));
    await ctx.plugin(await load('dsh-tool-subagent'),{provider:'spawn',toolName:'subagent',backgroundMode:'one-shot',modelSelectionSettings:false,maxDepth:2});
  }
  await ctx.plugin(await load('dsh-tool-jobs'));
  await ctx.plugin(await load('dsh-tool-goal'));
  ctx.on('session/event',(session,event)=>{if(session.id===h.agent?.id){h.events.push(event);h.changed();}});
  ctx.on('agent/status',()=>h.changed());
  ctx.on('tools/result',(exec,result)=>{h.toolResults.push({name:exec.name,isError:result.isError,code:result.error?.info?.code});h.changed();});
  ctx.on('agent/error',({error})=>{h.lastError=error.code??error.message;h.changed();});
  class Adapter extends llm.LlmAdapter {
    async *stream(options) {
      const agent=ctx.agents.currentInitiator();
      const call={main:agent===h.agent,agent,index:h.calls.filter(c=>c.agent===agent).length+1};
      h.calls.push(call);h.changed();
      const answer=(await h.onCall?.(h,call))??{};
      options.signal?.throwIfAborted();
      if(answer.throw)throw new Error('Controlled provider failure');
      const block=answer.tool?{type:'tool-call',id:'prototype-call-'+h.calls.length,name:answer.tool.name,arguments:JSON.stringify(answer.tool.args??{})}:{type:'text',text:'Prototype response.'};
      yield {type:'block-start',index:0,blockType:block.type};
      yield {type:'block-end',index:0,block};
      yield {type:'finish',reason:{kind:answer.finish??(answer.tool?'tool-calls':'stop')}};
    }
  }
  ctx.llm.registerAdapter(['prototype'],new Adapter());
  h.driverFiber=ctx.plugin(await load('dsh-goal-round-driver'));
  await h.driverFiber;
  h.handle=await ctx.agents.create({sessionId:'prototype-main',agentOptions:{provider:'prototype',model:'local'}});
  h.agent=h.handle.agent;
  h.startJob=()=>{
    const done=Promise.withResolvers();let cancels=0;
    const id=ctx.jobs.start({kind:'bash',label:'Controlled research work',owner:h.agent.id,run:()=>({done:done.promise,cancel:()=>{cancels++;done.resolve({status:'killed'});}})});
    const job={id,finish:()=>done.resolve({status:'completed',result:'Research work finished.'}),cancels:()=>cancels};h.jobs.push(job);return job;
  };
  h.live=()=>ctx.jobs.list(h.agent.id).some(j=>j.owner===h.agent.id&&['running','stopping'].includes(j.status)) || ctx.agents.list().some(a=>a.session.header.origin==='subagent'&&a.session.header.parentSession===h.agent.id);
  h.goal=()=>ctx.goals.get(h.agent);
  h.createGoal=(maxGoalRounds=1)=>ctx.goals.create(h.agent,{objective:'Prototype objective',maxGoalRounds});
  h.finishGoal=()=>{if(h.ctx.agents.get(h.agent.id)!==h.agent)return;const g=h.goal();if(g&&g.phase!=='complete')ctx.goals.complete(h.agent,g);};
  if(gate){
    const holds=new Map(),lastFinish=new Map();let enabled=true;
    const control={holds,release(agent,reason){const wait=holds.get(agent);if(!wait)return;holds.delete(agent);h.releases.push({reason});wait.resolve();h.changed();},releaseAll(reason){for(const agent of [...holds.keys()])control.release(agent,reason);}};
    h.gate=control;
    h.gateFiber=ctx.plugin({name:'throwaway-turn-stopping-wait',inject:['agents','goals','jobs'],apply(gctx){
      gctx.on('llm/stream',(_options,next)=>{
        const caller=gctx.agents.currentInitiator();
        return(async function*(){let reason='unknown';try{for await(const chunk of next()){if(chunk.type==='finish')reason=chunk.reason.kind;yield chunk;}}finally{if(caller)lastFinish.set(caller,reason);}})();
      });
      gctx.on('agent/inbox/inserted',({agent})=>control.release(agent,'inbox'));
      gctx.on('goal/changed',({agent})=>{if(releaseOnGoalChange||gctx.goals.get(agent)?.phase!=='active')control.release(agent,'goal-change');});
      gctx.on('goal/activation-changed',({sessionId})=>{const agent=gctx.agents.get(sessionId);if(agent&&gctx.goals.get(agent)?.activation!=='armed')control.release(agent,'activation-change');});
      gctx.jobs.events.subscribe({owners:'all'},event=>{if(event.type==='settled')queueMicrotask(()=>{const agent=gctx.agents.get(event.job.owner);if(agent&&holds.has(agent)&&(!h.live()||agent.inbox.hasPending))control.release(agent,'job-settled');});});
      gctx.on('agent/turn-stopping',({agent,signal})=>{
        if(agent!==h.agent)return;
        h.hookEntries++;
        const goal=gctx.goals.get(agent);
        if(!enabled||signal.aborted||!goal||goal.phase!=='active'||goal.activation!=='armed'||!h.live()||agent.inbox.hasPending||(finishGuard&&lastFinish.get(agent)!=='stop')){h.changed();return;}
        const wait=Promise.withResolvers();holds.set(agent,wait);
        const abort=()=>control.release(agent,'abort');
        if(observeAbort)signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted&&observeAbort)abort();
        if(agent.inbox.hasPending||!h.live())control.release(agent,'recheck');
        h.changed();
        return wait.promise.finally(()=>signal.removeEventListener('abort',abort));
      });
      gctx.effect(()=>()=>{enabled=false;control.releaseAll('unload');});
    }});
    await h.gateFiber;
  }
  h.begin=()=>{h.agent.followup(message('Begin controlled work.'));h.createGoal();};
  h.cleanup=async()=>{
    h.finishGoal();h.gate?.releaseAll('cleanup');
    for(const j of h.jobs)j.finish();
    if(h.childDone)h.childDone.resolve();
    await bounded(h.handle.dispose(),'handle cleanup');
    await bounded(ctx.fiber.dispose(),'context cleanup');
  };
  return h;
}
async function scenario(name,options,body){
  const h=await runtime(options);
  try{const observations=await body(h);results.push({scenario:name,observations});console.log(JSON.stringify(results.at(-1)));}
  finally{await h.cleanup();}
}
const held=h=>h.gate.holds.has(h.agent);
const goalTool=(h,action,extra={})=>({tool:{name:'update_goal',args:{goal_id:h.goal().id,revision:h.goal().revision,action,...extra}}});
await scenario('native-baseline-background-does-not-keep-running',{gate:false},async h=>{h.startJob();h.begin();await h.until(()=>h.goal()?.phase==='blocked','baseline cap');return {state:snapshot(h),jobStillRunning:h.live()};});
await scenario('hold-and-native-job-notice-release',{},async h=>{const j=h.startJob();h.begin();await h.until(()=>held(h),'hold');await tick();const waiting=snapshot(h);j.finish();await h.until(()=>h.goal()?.phase==='blocked','native next round');return {waiting,after:snapshot(h),noGateGoalMutations:h.events.filter(e=>e.type==='goal/change').map(e=>e.data.operation)};});
await scenario('native-round-completes-after-job-inject',{onCall:async(h,c)=>{if(c.main&&c.index===1)h.startJob();if(c.main&&c.index===2)return{tool:{name:'get_goal'}};if(c.main&&c.index===3)return goalTool(h,'complete');}},async h=>{h.createGoal(3);await h.until(()=>held(h),'goal-source hold');const before=snapshot(h);h.jobs[0].finish();await h.until(()=>h.goal()?.phase==='complete','native completion');await bounded(h.agent.whenIdle(),'completion idle');return {before,after:snapshot(h)};});
for(const delivery of ['followup','steer'])await scenario('human-'+delivery+'-releases-and-reholds',{},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'first hold');h.agent[delivery](message('Human steering.'));await h.until(()=>h.calls.length>=2&&held(h),'second hold');return snapshot(h);});
await scenario('prequeued-followup-is-not-stranded',{},async h=>{let once=false;h.ctx.on('agent/turn-stopping',({agent})=>{if(!once){once=true;agent.followup(message('Prequeued human work.'));}},{prepend:true});h.startJob();h.begin();await h.until(()=>h.calls.length>=2&&held(h),'prequeued input');return snapshot(h);});
await scenario('cancel-observes-abort-and-unwinds',{},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'cancel hold');h.agent.cancel({kind:'user'});await bounded(h.agent.whenIdle(),'cancel idle');return snapshot(h);});
await scenario('negative-cancel-without-abort-listener',{observeAbort:false},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'unsafe cancel hold');h.agent.cancel({kind:'user'});await tick();const stuck=snapshot(h);h.gate.releaseAll('manual-rescue');await bounded(h.agent.whenIdle(),'rescued idle');return {stuck,afterRescue:snapshot(h)};});
await scenario('agent-disposal-unwinds-before-job-owner-cleanup',{},async h=>{const j=h.startJob();h.begin();await h.until(()=>held(h),'dispose hold');await bounded(h.handle.dispose(),'dispose held agent');return {agentDetached:!h.ctx.agents.get(h.agent.id),held:h.gate.holds.size,producerCancels:j.cancels(),releases:h.releases.map(r=>r.reason)};});
await scenario('gate-unload-preserves-native-driver',{},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'unload hold');await bounded(h.gateFiber.dispose(),'gate unload');await h.until(()=>h.goal()?.phase==='blocked','unloaded native driver');return snapshot(h);});
for(const action of ['complete','pause'])await scenario('host-'+action+'-while-held',{},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'terminal hold');h.ctx.goals[action](h.agent,h.goal());await bounded(h.agent.whenIdle(),'terminal idle');return snapshot(h);});
await scenario('negative-max-tokens-unfiltered-hold',{finishGuard:false,onCall:()=>({finish:'max-tokens'})},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'cutoff hold');await tick();const delayed=snapshot(h);h.gate.releaseAll('manual-rescue');await bounded(h.agent.whenIdle(),'cutoff idle');return {delayed,after:snapshot(h)};});
await scenario('max-tokens-finish-guard-preserves-native-disarm',{onCall:()=>({finish:'max-tokens'})},async h=>{h.startJob();h.begin();await bounded(h.agent.whenIdle(),'guarded cutoff');return snapshot(h);});
await scenario('provider-error-bypasses-stopping-hook',{onCall:()=>({throw:true})},async h=>{h.startJob();h.begin();await bounded(h.agent.whenIdle(),'error idle');return {state:snapshot(h),hookEntries:h.hookEntries,errorObserved:Boolean(h.lastError)};});
await scenario('negative-autonomous-edit-keeps-stale-round-authority',{releaseOnGoalChange:false,onCall:async(h,c)=>{if(c.main&&c.index===1)h.startJob();if(c.main&&c.index===2)return{tool:{name:'get_goal'}};if(c.main&&c.index===3)return goalTool(h,'complete');}},async h=>{h.createGoal(3);await h.until(()=>held(h),'stale hold');h.ctx.goals.edit(h.agent,h.goal(),{objective:'Changed objective'});h.jobs[0].finish();await h.until(()=>h.toolResults.some(r=>r.name==='update_goal'),'stale tool result');return snapshot(h);});
await scenario('goal-edit-releases-for-native-fresh-revision',{},async h=>{h.startJob();h.agent.followup(message('Begin work.'));h.createGoal(3);await h.until(()=>held(h),'edit hold');h.ctx.goals.edit(h.agent,h.goal(),{objective:'Changed objective'});await h.until(()=>h.calls.length>=2&&held(h),'fresh goal hold');return snapshot(h);});
await scenario('held-human-turn-retains-native-edit-authority',{onCall:async(h,c)=>{if(c.main&&c.index===2)return{tool:{name:'get_goal'}};if(c.main&&c.index===3)return goalTool(h,'edit',{objective:'Edited after notice'});}},async h=>{const j=h.startJob();h.begin();await h.until(()=>held(h),'human authority hold');j.finish();await h.until(()=>h.toolResults.some(r=>r.name==='update_goal'),'edit result');return snapshot(h);});
await scenario('idle-goal-start-with-live-job-admits-one-round',{},async h=>{h.startJob();h.agent.followup(message('Work without goal.'));await bounded(h.agent.whenIdle(),'initial idle');h.createGoal(3);await h.until(()=>held(h),'idle start hold');return snapshot(h);});
await scenario('serial-later-stopping-listener-is-delayed',{},async h=>{let later=0;h.ctx.on('agent/turn-stopping',()=>{later++;});h.startJob();h.begin();await h.until(()=>held(h),'serial hold');await tick();const waiting={state:snapshot(h),laterListenerCalls:later};h.finishGoal();await bounded(h.agent.whenIdle(),'serial release');return {waiting,laterListenerCalls:later};});
await scenario('native-continuable-child-notice-releases-parent',{children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();h.child=await h.ctx.subagents.startContinuable({provider:'spawn',label:'Controlled child',request:{parent:h.agent,prompt:[{type:'text',text:'Child research task.'}],maxDepth:1},signal:new AbortController().signal});}else if(!c.main){await bounded(h.childDone.promise,'controlled child release');}}},async h=>{h.begin();await h.until(()=>held(h),'child hold');const waiting=snapshot(h);h.childDone.resolve();await h.until(()=>h.goal()?.phase==='blocked','child notice and native round');return {waiting,after:snapshot(h),childDetached:!h.ctx.agents.get(h.child.childId)};});

await scenario('disarm-only-releases-without-rearming',{},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'disarm hold');h.ctx.goals.disarm(h.agent);await bounded(h.agent.whenIdle(),'disarmed idle');return snapshot(h);});
await scenario('host-clear-releases-while-work-remains',{},async h=>{h.startJob();h.begin();await h.until(()=>held(h),'clear hold');h.ctx.goals.clear(h.agent,h.goal());await bounded(h.agent.whenIdle(),'cleared idle');return snapshot(h);});
await scenario('native-driver-unload-does-not-hang-held-round',{onCall:async(h,c)=>{if(c.main&&c.index===1)h.startJob();}},async h=>{h.createGoal(3);await h.until(()=>held(h),'driver hold');await bounded(h.driverFiber.dispose(),'driver unload');await bounded(h.agent.whenIdle(),'driver-unloaded idle');return snapshot(h);});
await scenario('pre-step-rejection-bypasses-wait-and-admits-native-round',{},async h=>{let rejected=false;h.ctx.on('agent/pre-step',async({messages},next)=>{if(!rejected&&messages.some(m=>m.source.kind==='user')){rejected=true;return{kind:'reject'};}return next();});h.startJob();h.begin();await h.until(()=>held(h),'rejected input fallback');return snapshot(h);});
await scenario('earlier-serial-bail-can-skip-wait-gate',{},async h=>{let once=false;h.ctx.on('agent/turn-stopping',()=>{if(!once){once=true;return true;}},{prepend:true});h.startJob();h.begin();await h.until(()=>h.calls.length>=2&&held(h),'serial bail fallback');return snapshot(h);});
await scenario('native-child-message-while-child-still-live',{children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();h.child=await h.ctx.subagents.startContinuable({provider:'spawn',label:'Controlled child',request:{parent:h.agent,prompt:[{type:'text',text:'Child research task.'}],maxDepth:1},signal:new AbortController().signal});}else if(!c.main)await bounded(h.childDone.promise,'child partial release');}},async h=>{h.begin();await h.until(()=>held(h),'partial hold');const child=h.ctx.agents.get(h.child.childId);await h.ctx.subagents.sendMessage(child,h.agent.id,[{type:'text',text:'Need parent decision while still working.'}],{signal:new AbortController().signal});await h.until(()=>h.calls.filter(c=>c.main).length>=2&&held(h),'parent rehold after child message');const whileLive=snapshot(h);h.childDone.resolve();await h.until(()=>h.goal()?.phase==='blocked','partial then final notice');return{whileLive,after:snapshot(h)};});
await scenario('native-one-shot-tool-job-notice',{children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();return{tool:{name:'subagent',args:{description:'Controlled one-shot child',prompt:'Child task',run_in_background:true}}};}if(!c.main)await bounded(h.childDone.promise,'one-shot release');}},async h=>{h.begin();await h.until(()=>held(h),'one-shot hold');const waiting=snapshot(h);h.childDone.resolve();await h.until(()=>h.goal()?.phase==='blocked','one-shot notice and next round');return{waiting,after:snapshot(h)};});

await scenario('autonomous-edit-fresh-native-round-can-complete',{onCall:async(h,c)=>{if(c.main&&c.index===1)h.startJob();if(c.main&&c.index===3)return{tool:{name:'get_goal'}};if(c.main&&c.index===4)return goalTool(h,'complete');}},async h=>{h.createGoal(3);await h.until(()=>held(h),'autonomous edit first hold');h.ctx.goals.edit(h.agent,h.goal(),{objective:'Changed autonomous objective'});await h.until(()=>h.calls.length>=2&&held(h),'fresh autonomous hold');const refreshed=snapshot(h);h.jobs[0].finish();await h.until(()=>h.goal()?.phase==='complete','fresh autonomous completion');await bounded(h.agent.whenIdle(),'fresh completion idle');return{refreshed,after:snapshot(h)};});
await scenario('nonhuman-followup-alone-has-no-completion-authority',{onCall:async(h,c)=>{if(c.main&&c.index===1)return{tool:{name:'get_goal'}};if(c.main&&c.index===2)return goalTool(h,'complete');}},async h=>{h.agent.followup(message('Standalone background notice.','tool-jobs'));h.createGoal(3);await h.until(()=>h.toolResults.some(r=>r.name==='update_goal'),'nonhuman completion refusal');return snapshot(h);});
console.log(JSON.stringify({summary:{scenarioCount:results.length,nativeVersion:req('@deepseek-ai/dsh-agent-loop/package.json').version,allScenariosFinished:true,liveProfilesLoaded:false,networkModelCalls:false},results},null,2));
