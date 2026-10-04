// Research policy: native job ownership and live subagent ancestry, not parent status.
export function hasBackgroundWork(ctx, agent) {
  const jobs=ctx.get('jobs');
  if(jobs?.list(agent.session.id).some(j=>j.owner===agent.session.id&&['running','stopping'].includes(j.status)))return true;
  const byParent=new Map();
  for(const child of ctx.agents.list()){
    const {origin,parentSession}=child.session.header;
    if(origin!=='subagent'||parentSession===undefined)continue;
    const siblings=byParent.get(parentSession)??[];siblings.push(child);byParent.set(parentSession,siblings);
  }
  const visited=new Set();const pending=[agent.session.id];
  while(pending.length){const parent=pending.pop();for(const child of byParent.get(parent)??[]){if(child===agent||visited.has(child.id))continue;visited.add(child.id);pending.push(child.session.id);}}
  return visited.size>0;
}
// Experimental extra seam: detached continuable children still owe a real native notice.
export function createWorkPolicy(ctx) {
  const known=new Map(),pending=new Map();
  const policy={onCleared:undefined,canSchedule(agent){return !hasBackgroundWork(ctx,agent)&&!(pending.get(agent)?.size);}};
  const remember=agent=>{
    if(agent.session.header.origin!=='subagent')return;
    const parent=ctx.agents.get(agent.session.header.parentSession);
    const mode=agent.session.snapshotEvents().findLast(e=>e.type==='subagent/descriptor')?.data.mode;
    known.set(agent,{parent,mode});
  };
  for(const agent of ctx.agents.list())remember(agent);
  ctx.on('agent/created',({agent})=>remember(agent));
  ctx.on('session/event',(session,event)=>{if(event.type==='subagent/descriptor'){const agent=ctx.agents.get(session.id);if(agent)remember(agent);}});
  ctx.on('agent/disposed',({agent})=>{
    const entry=known.get(agent);known.delete(agent);pending.delete(agent);
    if(entry?.mode!=='continuable'||!entry.parent||ctx.agents.get(entry.parent.id)!==entry.parent)return;
    const ids=pending.get(entry.parent)??new Set();ids.add(agent.id);pending.set(entry.parent,ids);
    // Deliberately do not wake merely because a child disappeared.
  });
  ctx.on('agent/inbox/inserted',({agent,message})=>{
    if(message.source.kind!=='subagent-settled')return;
    const ids=pending.get(agent);if(!ids?.delete(message.source.senderSessionId))return;
    if(ids.size===0)pending.delete(agent);
    policy.onCleared?.(agent);
  });
  ctx.effect(()=>()=>{known.clear();pending.clear();policy.onCleared=undefined;});
  return policy;
}
