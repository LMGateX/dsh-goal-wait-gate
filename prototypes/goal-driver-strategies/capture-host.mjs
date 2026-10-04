// Read-only module fingerprints, no profile loading; run with the installed @deepseek-ai directory.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if(!process.argv[2])throw new Error('Supply the installed @deepseek-ai directory.');
const req=createRequire(resolve(process.argv[2],'dsh-agent-loop/package.json'));
const names=['cordis','dsh-session','dsh-session-projection','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-jobs-local','dsh-tool-jobs','dsh-tool-goal','dsh-subagent','dsh-subagent-spawn-in-process','dsh-tool-subagent','dsh-session-persistence-jsonl','dsh-invariants'];
console.log(JSON.stringify({node:process.version,packages:names.map(n=>{const p='@deepseek-ai/'+n;return{package:p,version:req(p+'/package.json').version,entrySha256:createHash('sha256').update(readFileSync(req.resolve(p))).digest('hex')};})},null,2));
