// 直接测 client-optimizer 的逻辑（不涉及浏览器）
import { createClientOptimizer } from '../ui/client-optimizer.js';

let pass=0, fail=0;
const check=(n,c,e='')=>{ c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+' '+e)); };

const cfg={enabled:true,maxBreakpoints:4,ttl:'5m'};
const opt=createClientOptimizer({getConfig:()=>cfg});

function req(turn, {dynamic=false}={}){
  const messages=[];
  for(let i=0;i<turn;i++){
    messages.push({role:'user',content:`U${i} `+'u'.repeat(200)});
    messages.push({role:'assistant',content:`A${i} `+'a'.repeat(600)});
  }
  messages.push({role:'user',content:`U${turn} `+'u'.repeat(200)});
  return {
    chat_completion_source:'openrouter',
    model:'anthropic/claude-sonnet-4',
    messages:[
      {role:'system',content:'MAIN PROMPT '+ (dynamic?`r=${Math.random()}`:'')},
      {role:'system',content:'CARD '+'c'.repeat(1500)},
      ...messages,
    ],
  };
}

console.log('=== 1. OpenRouter 路径应注入断点 ===');
const b1=req(3);
const changed1=opt.optimize(b1);
check('识别为可优化', changed1===true);
const marks1=[];
b1.messages.forEach((m,i)=>{ if(Array.isArray(m.content)&&m.content.some(p=>p.cache_control)) marks1.push(i); });
check('有断点', marks1.length>0, JSON.stringify(marks1));
check('断点数 <= 4', marks1.length<=4, `${marks1.length}`);
check('断点是 ephemeral', JSON.stringify(b1).includes('"ephemeral"'));
console.log('    断点位置:', marks1);

console.log('\n=== 2. 第二轮：稳定前缀被识别 ===');
const b2=req(4);
opt.optimize(b2);
const marks2=[];
b2.messages.forEach((m,i)=>{ if(Array.isArray(m.content)&&m.content.some(p=>p.cache_control)) marks2.push(i); });
check('第二轮仍有断点', marks2.length>0, JSON.stringify(marks2));

console.log('\n=== 3. Claude 直连应跳过（服务端会丢断点）===');
const b3={chat_completion_source:'claude',model:'claude-sonnet-4',messages:[{role:'user',content:'hi'}]};
const changed3=opt.optimize(b3);
check('不处理 claude 直连', changed3===false);
check('未注入 cache_control', !JSON.stringify(b3).includes('cache_control'));

console.log('\n=== 4. 关闭开关后不处理 ===');
cfg.enabled=false;
const b4=req(5);
check('返回 false', opt.optimize(b4)===false);
check('无 cache_control', !JSON.stringify(b4).includes('cache_control'));
cfg.enabled=true;

console.log('\n=== 5. 重复调用不叠加断点 ===');
const b5=req(6);
opt.optimize(b5);
const first=(JSON.stringify(b5).match(/"cache_control"/g)||[]).length;
opt.optimize(b5);
const second=(JSON.stringify(b5).match(/"cache_control"/g)||[]).length;
check('断点数稳定', first===second, `${first} → ${second}`);

console.log('\n=== 6. 统计 ===');
const st=opt.stats();
check('记录了检查次数', st.inspected>0, JSON.stringify(st));
check('无错误', st.errors===0, `errors=${st.errors}`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
