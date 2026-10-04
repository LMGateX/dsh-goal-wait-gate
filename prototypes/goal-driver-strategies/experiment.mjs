// THROWAWAY RESEARCH, NOT AN INSTALLED PLUGIN. Native DSH modules; only LLM/producer work is controlled.
// node prototypes/turn-stopping-wait/native-experiment.mjs /path/to/@deepseek-ai
import { createRequire, registerHooks } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const root = process.argv[2];
if (!root) throw new Error('Supply the installed @deepseek-ai directory; no profile is loaded.');
const req = createRequire(resolve(root, 'dsh-agent-loop/package.json'));
const llmURL=pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href;
registerHooks({resolve(spec,context,next){if(spec==='@deepseek-ai/dsh-llm'&&context.parentURL?.includes('/prototypes/goal-driver-strategies/'))return{url:llmURL,shortCircuit:true};return next(spec,context);}});
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
  return {strategy:h.driver,status:h.agent.status,calls:h.calls.filter(c=>c.main).length,
    goal:goal&&{phase:goal.phase,activation:goal.activation,revision:goal.revision,roundsStarted:goal.roundsStarted,objective:goal.objective},
    turnEnds:h.events.filter(e=>e.type==='turn/end').length,
    admitted:(()=>{let turn;const admitted=[];for(const e of h.events){if(e.type==='turn/start')turn=e.data.turn;if(e.type==='user/message')admitted.push({turn,kind:e.data.source.kind,round:e.data.source.round,revision:e.data.source.revision});}return admitted;})(),
    toolResults:h.toolResults.map(r=>({name:r.name,isError:r.isError,code:r.code}))};
}
async function runtime({driver='background',jobsConfig={},children=false,doubleDriver=false,onCall}={}) {
  const ctx = new Context();
  const h = {ctx,calls:[],events:[],toolResults:[],jobs:[],waiters:[],onCall};
  h.changed = () => {for(const w of [...h.waiters]) if(w.predicate()){h.waiters.splice(h.waiters.indexOf(w),1);w.resolve();}};
  h.until = (predicate,label) => {if(predicate())return Promise.resolve(); const d=Promise.withResolvers();h.waiters.push({predicate,resolve:d.resolve});return bounded(d.promise,label);};
  for(const name of ['dsh-session','dsh-session-projection','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-goal','dsh-jobs-local','dsh-invariants'])await ctx.plugin((await load(name)).default);
  if(children){
    h.scratch=await mkdtemp(join(tmpdir(),'dsh-wait-research-'));
    await ctx.plugin((await load('dsh-session-persistence-jsonl')).default,{root:join(h.scratch,'sessions'),compression:'none'});
    await ctx.plugin((await load('dsh-subagent')).default);
    await ctx.plugin(await load('dsh-subagent-spawn-in-process'));
    await ctx.plugin(await load('dsh-tool-subagent'),{provider:'spawn',toolName:'subagent',backgroundMode:'one-shot',modelSelectionSettings:false,maxDepth:2});
  }
  await ctx.plugin(await load('dsh-tool-jobs'),jobsConfig);
  await ctx.plugin(await load('dsh-tool-goal'));
  await ctx.plugin(await load('dsh-goal-round-driver/invariant'));
  ctx.on('session/event',(session,event)=>{if(session.id===h.agent?.id){h.events.push(event);h.changed();}});
  ctx.on('agent/status',()=>h.changed());
  ctx.on('tools/result',(exec,result)=>{h.toolResults.push({name:exec.name,isError:result.isError,code:result.error?.info?.code});h.changed();});
  ctx.on('agent/error',({error})=>{h.lastError=error.code??error.message;h.changed();});
  class Adapter extends llm.LlmAdapter {
    async *stream(options) {
      const agent=ctx.agents.currentInitiator();
      const call={main:agent===h.agent,agent,signal:options.signal,index:h.calls.filter(c=>c.agent===agent).length+1};
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
  h.driver=driver;
  h.driverFiber=ctx.plugin(driver==='native'?await load('dsh-goal-round-driver'):await import(driver==='barrier'?'./background-driver-with-barrier.mjs':'./background-driver.mjs'));
  await h.driverFiber;
  if(doubleDriver){h.extraDriver=ctx.plugin(await load('dsh-goal-round-driver'));await h.extraDriver;}
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
  h.begin=()=>{h.agent.followup(message('Begin controlled work.'));h.createGoal();};
  h.cleanup=async()=>{
    h.finishGoal();
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
const goalTool=(h,action,extra={})=>({tool:{name:'update_goal',args:{goal_id:h.goal().id,revision:h.goal().revision,action,...extra}}});

for(const driver of ['native','background'])await scenario('idle-live-job-'+driver,{driver},async h=>{h.startJob();h.createGoal(1);if(driver==='native')await h.until(()=>h.goal()?.phase==='blocked','native baseline');else await tick();return{state:snapshot(h),jobStillRunning:h.live()};});
await scenario('normal-parent-closes-turn-and-remains-armed',{},async h=>{let later=0;h.ctx.on('agent/turn-stopping',()=>{later++;});h.startJob();h.begin();await bounded(h.agent.whenIdle(),'normal idle');await tick();return{state:snapshot(h),laterStopListener:later};});
for(const completionDelivery of ['wakeup','quiet'])await scenario('job-notice-'+completionDelivery,{jobsConfig:{completionDelivery}},async h=>{const j=h.startJob();h.begin();await bounded(h.agent.whenIdle(),'job wait idle');const before=snapshot(h);j.finish();await h.until(()=>h.goal()?.phase==='blocked','job next round');return{before,after:snapshot(h)};});
await scenario('multiple-jobs-notice-does-not-start-empty-round',{},async h=>{const a=h.startJob(),b=h.startJob();h.begin();await bounded(h.agent.whenIdle(),'multi idle');a.finish();await h.until(()=>h.calls.filter(c=>c.main).length>=2,'first notice');await bounded(h.agent.whenIdle(),'first notice idle');const partial=snapshot(h);b.finish();await h.until(()=>h.goal()?.phase==='blocked','all jobs settled');return{partial,after:snapshot(h)};});
await scenario('user-followup-runs-during-background-wait',{},async h=>{h.startJob();h.begin();await bounded(h.agent.whenIdle(),'human idle');h.agent.followup(message('New human input.'));await bounded(h.agent.whenIdle(),'new human idle');await tick();return snapshot(h);});
await scenario('goal-edit-while-idle-work-live-keeps-latest-revision',{},async h=>{const j=h.startJob();h.begin();await bounded(h.agent.whenIdle(),'edit idle');h.ctx.goals.edit(h.agent,h.goal(),{objective:'New stored objective'});await tick();const edited=snapshot(h);j.finish();await h.until(()=>h.goal()?.phase==='blocked','edited round');return{edited,after:snapshot(h)};});
await scenario('native-tool-completion-after-notice-gets-new-goal-authority',{onCall:async(h,c)=>{if(c.main&&[2,5].includes(c.index))return{tool:{name:'get_goal'}};if(c.main&&[3,6].includes(c.index))return goalTool(h,'complete');}},async h=>{const j=h.startJob();h.begin();await bounded(h.agent.whenIdle(),'tool wait');j.finish();await h.until(()=>h.goal()?.phase==='complete','tool complete');await bounded(h.agent.whenIdle(),'wrapup idle');return snapshot(h);});
await scenario('pre-step-user-rejection-does-not-bypass-work-guard',{},async h=>{let rejected=false;h.ctx.on('agent/pre-step',async({messages},next)=>{if(!rejected&&messages.some(m=>m.source.kind==='user')){rejected=true;return{kind:'reject'};}return next();});h.startJob();h.begin();await bounded(h.agent.whenIdle(),'reject idle');await tick();return snapshot(h);});
for(const finish of ['max-tokens','error'])await scenario('native-abnormal-'+finish,{onCall:()=>finish==='error'?{throw:true}:{finish}},async h=>{h.startJob();h.begin();await bounded(h.agent.whenIdle(),'abnormal idle');return{state:snapshot(h),errorObserved:Boolean(h.lastError)};});
await scenario('original-round-cap-is-preserved-even-with-live-work',{onCall:async(h,c)=>{if(c.main&&c.index===1)h.startJob();}},async h=>{h.createGoal(1);await h.until(()=>h.goal()?.phase==='blocked','original cap');return{state:snapshot(h),jobStillRunning:h.live()};});
await scenario('job-appears-after-goal-inbox-reservation',{},async h=>{let raced=false;h.ctx.on('agent/inbox/inserted',({message})=>{if(!raced&&message.source.kind==='goal'){raced=true;h.startJob();}});h.createGoal(2);await h.until(()=>h.events.some(e=>e.type==='turn/end'),'race rejected turn');await bounded(h.agent.whenIdle(),'race idle');const rejected=snapshot(h);h.jobs[0].finish();await h.until(()=>h.goal()?.phase==='blocked','race retry cap');return{rejected,after:snapshot(h)};});
await scenario('job-appears-during-downstream-pre-step',{},async h=>{let raced=false;h.ctx.on('agent/pre-step',async({messages},next)=>{if(!raced&&messages.some(m=>m.source.kind==='goal')){raced=true;h.startJob();}return next();});h.createGoal(2);await h.until(()=>h.events.some(e=>e.type==='turn/end'),'post-fence reject');await bounded(h.agent.whenIdle(),'post-fence idle');const rejected=snapshot(h);h.jobs[0].finish();await h.until(()=>h.goal()?.phase==='blocked','post-fence retry');return{rejected,after:snapshot(h)};});
await scenario('work-appears-during-flush-checkpoint',{},async h=>{const entered=Promise.withResolvers(),release=Promise.withResolvers();let once=false;h.ctx.on('session/flush',async()=>{if(!once){once=true;entered.resolve();await release.promise;}});h.createGoal(2);await bounded(entered.promise,'flush entered');h.startJob();release.resolve();await tick();return snapshot(h);});
await scenario('flush-failure-preserves-native-disarm',{},async h=>{let once=false;h.ctx.on('session/flush',()=>{if(!once){once=true;throw new Error('Controlled flush failure');}});h.createGoal(2);await tick();return snapshot(h);});
await scenario('downstream-goal-rejection-preserves-native-blocker',{},async h=>{h.ctx.on('agent/pre-step',async({messages},next)=>messages.some(m=>m.source.kind==='goal')?{kind:'reject'}:next());h.createGoal(2);await h.until(()=>h.goal()?.phase==='blocked','native prompt rejection');return snapshot(h);});
await scenario('native-continuable-settlement-before-next-goal',{children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();h.child=await h.ctx.subagents.startContinuable({provider:'spawn',label:'Research child',request:{parent:h.agent,prompt:[{type:'text',text:'Child task.'}],maxDepth:1},signal:new AbortController().signal});}else if(!c.main)await bounded(h.childDone.promise,'child release');}},async h=>{h.begin();await h.until(()=>Boolean(h.child)&&h.agent.status==='idle','parent idle with child');const before=snapshot(h);h.childDone.resolve();await h.until(()=>h.goal()?.phase==='blocked','child settled next round');return{before,after:snapshot(h)};});
await scenario('native-one-shot-child-via-tool',{children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();return{tool:{name:'subagent',args:{description:'Research one-shot child',prompt:'Child task',run_in_background:true}}};}if(!c.main)await bounded(h.childDone.promise,'one-shot release');}},async h=>{h.begin();await h.until(()=>h.toolResults.some(r=>r.name==='subagent')&&h.agent.status==='idle','one-shot parent idle');const before=snapshot(h);h.childDone.resolve();await h.until(()=>h.goal()?.phase==='blocked','one-shot next round');return{before,after:snapshot(h)};});
await scenario('native-child-can-request-parent-while-still-live',{children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();h.child=await h.ctx.subagents.startContinuable({provider:'spawn',label:'Research child',request:{parent:h.agent,prompt:[{type:'text',text:'Child task.'}],maxDepth:1},signal:new AbortController().signal});}else if(!c.main)await bounded(h.childDone.promise,'child relay release');}},async h=>{h.begin();await h.until(()=>Boolean(h.child)&&h.agent.status==='idle','relay parent idle');await h.ctx.subagents.sendMessage(h.ctx.agents.get(h.child.childId),h.agent.id,[{type:'text',text:'Need parent decision.'}],{signal:new AbortController().signal});await h.until(()=>h.calls.filter(c=>c.main).length>=2,'relay processed');await bounded(h.agent.whenIdle(),'relay idle');const stillLive=snapshot(h);h.childDone.resolve();await h.until(()=>h.goal()?.phase==='blocked','relay settled');return{stillLive,after:snapshot(h)};});

for(const driver of ['background','barrier'])await scenario('delayed-native-child-notice-with-job-trigger-'+driver,{driver,children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();h.child=await h.ctx.subagents.startContinuable({provider:'spawn',label:'Delayed-notice child',request:{parent:h.agent,prompt:[{type:'text',text:'Child task.'}],maxDepth:1},signal:new AbortController().signal});}else if(!c.main)await bounded(h.childDone.promise,'delayed child finish');}},async h=>{
  const job=h.startJob();h.begin();await h.until(()=>Boolean(h.child)&&h.agent.status==='idle','delayed parent idle');
  const originalFollowup=h.agent.followup.bind(h.agent),noticeSeen=Promise.withResolvers();
  h.agent.followup=input=>{if(input.source.kind==='subagent-settled'){h.delayedNotice=input;noticeSeen.resolve();return;}originalFollowup(input);};
  h.childDone.resolve();await bounded(noticeSeen.promise,'native notice captured');job.finish();
  if(driver==='background')await h.until(()=>h.goal()?.phase==='blocked','naive rounds before notice');
  else{await h.until(()=>h.calls.filter(c=>c.main).length>=2,'barrier job notice');await bounded(h.agent.whenIdle(),'barrier idle');await tick();}
  const beforeDelivery=snapshot(h);h.agent.followup=originalFollowup;originalFollowup(h.delayedNotice);
  if(driver==='barrier')await h.until(()=>h.goal()?.phase==='blocked','barrier after notice');else await bounded(h.agent.whenIdle(),'naive late notice idle');
  return{controlledTransportDelay:true,beforeDelivery,after:snapshot(h)};
});
await scenario('late-work-after-pre-step-before-request-admission',{},async h=>{let started=false;h.ctx.on('agent/request',async(_payload,next)=>{if(!started){started=true;h.startJob();}return next();});h.createGoal(2);await h.until(()=>h.events.some(e=>e.type==='turn/end'),'late request turn');await bounded(h.agent.whenIdle(),'late request idle');return{state:snapshot(h),workStillLive:h.live()};});
await scenario('negative-two-independent-schedulers-conflict',{doubleDriver:true},async h=>{h.createGoal(2);await tick();await bounded(h.agent.whenIdle(),'dual scheduler idle');return{twoSchedulersMounted:true,state:snapshot(h)};});
await scenario('handoff-disarms-until-real-human-tool-resume',{onCall:async(h,c)=>{if(h.resuming&&c.main&&c.index===2)return{tool:{name:'get_goal'}};if(h.resuming&&c.main&&c.index===3)return goalTool(h,'resume');}},async h=>{h.startJob();h.begin();await bounded(h.agent.whenIdle(),'handoff idle');await bounded(h.driverFiber.dispose(),'old driver disposal');h.driverFiber=h.ctx.plugin(await load('dsh-goal-round-driver'));await h.driverFiber;h.driver='native';await tick();const beforeResume=snapshot(h);h.resuming=true;h.agent.followup(message('Human explicitly asks to resume the goal.'));await h.until(()=>h.goal()?.phase==='blocked','native after explicit resume');return{beforeResume,after:snapshot(h)};});
await scenario('cancel-active-goal-round-preserves-native-pause',{onCall:async(h,c)=>{if(c.main&&c.index===1){h.startJob();await new Promise(resolve=>c.signal.addEventListener('abort',resolve,{once:true}));}}},async h=>{h.createGoal(2);await h.until(()=>h.calls.length===1,'cancel active request');h.agent.cancel({kind:'user'});await bounded(h.agent.whenIdle(),'cancel active idle');return snapshot(h);});
await scenario('disarm-while-idle-wait-never-rearms',{},async h=>{const j=h.startJob();h.begin();await bounded(h.agent.whenIdle(),'disarm wait');h.ctx.goals.disarm(h.agent);j.finish();await h.until(()=>h.calls.length>=2,'disarmed notice');await bounded(h.agent.whenIdle(),'disarmed notice idle');return snapshot(h);});
await scenario('complete-while-idle-wait-no-goal-round',{},async h=>{h.startJob();h.begin();await bounded(h.agent.whenIdle(),'complete wait');h.finishGoal();await tick();return snapshot(h);});
await scenario('replacement-unload-with-idle-live-job-is-bounded',{},async h=>{const j=h.startJob();h.begin();await bounded(h.agent.whenIdle(),'unload idle');await bounded(h.driverFiber.dispose(),'replacement unload');return{state:snapshot(h),jobStillLive:h.live(),producerCancels:j.cancels()};});

await scenario('negative-current-gate-unload-rearms-during-uncoordinated-switch',{driver:'native'},async h=>{const {goalWaitGate}=await import('../../src/index.ts');h.activationFiber=h.ctx.plugin(goalWaitGate);await h.activationFiber;h.startJob();h.begin();await bounded(h.agent.whenIdle(),'activation hold idle');const before=snapshot(h);await bounded(h.activationFiber.dispose(),'activation gate unload');await h.until(()=>h.goal()?.phase==='blocked','uncoordinated resume round');return{before,after:snapshot(h),jobStillLive:h.live()};});
await scenario('pending-notice-barrier-needs-explicit-loss-policy',{driver:'barrier',children:true,onCall:async(h,c)=>{if(c.main&&c.index===1){h.childDone=Promise.withResolvers();h.child=await h.ctx.subagents.startContinuable({provider:'spawn',label:'Missing-notice child',request:{parent:h.agent,prompt:[{type:'text',text:'Child task.'}],maxDepth:1},signal:new AbortController().signal});}else if(!c.main)await bounded(h.childDone.promise,'missing child finish');}},async h=>{h.begin();await h.until(()=>Boolean(h.child)&&h.agent.status==='idle','missing parent idle');const original=h.agent.followup.bind(h.agent),seen=Promise.withResolvers();h.agent.followup=input=>{if(input.source.kind==='subagent-settled'){h.delayedNotice=input;seen.resolve();return;}original(input);};h.childDone.resolve();await bounded(seen.promise,'suppressed native notice');h.ctx.goals.edit(h.agent,h.goal(),{objective:'Trigger re-evaluation while notice is missing'});await tick();const withoutNotice=snapshot(h);h.agent.followup=original;original(h.delayedNotice);await h.until(()=>h.goal()?.phase==='blocked','released missing notice');return{controlledTransportSuppression:true,withoutNotice,after:snapshot(h)};});
console.log(JSON.stringify({summary:{scenarioCount:results.length,nativeVersion:req('@deepseek-ai/dsh-agent-loop/package.json').version,allScenariosFinished:true,nativeGoalPromptInvariantEnabled:true,networkModelCalls:false,liveProfilesLoaded:false},results},null,2));
