const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const id = () => crypto.randomUUID();
const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function passwordHash(p) { const salt = crypto.getRandomValues(new Uint8Array(16)); const k = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']); const v = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000 }, k, 256); return `pbkdf2:${b64(salt)}:${b64(v)}`; }
async function passwordOk(p, h) { try { const [,s,v] = h.split(':'); const k = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']); const got = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(s), iterations: 210000 }, k, 256)); const want = unb64(v); return got.length === want.length && got.every((x,i)=>x===want[i]); } catch { return false; } }
const seed = { id:'main-335', title:'UFC 335 · 메인매치', a:'전재신', b:'오승민', time:'2026-11-06T12:35:00+09:00', place:'인수실', rules:'킥복싱', poster:'/poster.svg', photoA:'', photoB:'', video:'', closed:false, result:'', timer:{round:1,remaining:70,started:null} };
let ready = false;
async function initialize(env) {
 if(ready)return;
 await env.DB.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE,password TEXT NOT NULL,points INTEGER NOT NULL DEFAULT 100,admin INTEGER NOT NULL DEFAULT 0,disabled INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,data TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT 0,result TEXT NOT NULL DEFAULT '',archived INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS votes(user TEXT NOT NULL,match TEXT NOT NULL,side TEXT NOT NULL,PRIMARY KEY(user,match));
 CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,type TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
 let admin=await env.DB.prepare('SELECT id FROM users WHERE admin=1').first();
 if(!admin){if(!env.ADMIN_PASSWORD)throw Error('Set ADMIN_PASSWORD as a Worker secret before first request');await env.DB.prepare('INSERT INTO users(id,name,password,points,admin,disabled,created) VALUES(?,?,?,?,1,0,?)').bind('admin','운영자',await passwordHash(env.ADMIN_PASSWORD),100,Date.now()).run();}
 await env.DB.prepare('INSERT OR IGNORE INTO matches(id,data,closed,result,archived,created) VALUES(?,?,0,\'\',0,?)').bind(seed.id,JSON.stringify(seed),Date.now()).run();
 ready=true;
}
const cookie = r => r.headers.get('cookie')?.match(/(?:^|;\s*)ringside_session=([^;]+)/)?.[1] || '';
const userBySession = async (env, token) => token ? env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user WHERE s.token=? AND s.expires>? AND u.disabled=0').bind(await sha(token), Date.now()).first() : null;
const pauseTimer = m => { if (m.timer.started !== null) m.timer.remaining=Math.max(0,m.timer.remaining-Math.floor((Date.now()-m.timer.started)/1000)); m.timer.started=null; };
const validMatch = m => typeof m==='object' && m && typeof m.id==='string';

async function adminData(env,u) {
 const settings = await env.DB.prepare("SELECT data FROM settings WHERE id='site'").first();
 if (!u?.admin) return { settings: settings ? JSON.parse(settings.data) : {}, members:[], allMatches:[], allVotes:[] };
 const [members,matches,votes] = await Promise.all([
  env.DB.prepare('SELECT id,name,points,admin,disabled FROM users ORDER BY created').all(),
  env.DB.prepare('SELECT data FROM matches ORDER BY created DESC').all(),
  env.DB.prepare('SELECT v.user,v.match,v.side,u.name FROM votes v JOIN users u ON u.id=v.user').all()
 ]);
 return { settings:settings?JSON.parse(settings.data):{}, members:members.results||[], allMatches:(matches.results||[]).map(x=>JSON.parse(x.data)), allVotes:votes.results||[] };
}
async function storeMatch(env,m) { await env.DB.prepare('UPDATE matches SET data=?,closed=?,result=?,archived=? WHERE id=?').bind(JSON.stringify(m),m.closed?1:0,m.result||'',m.archived?1:0,m.id).run(); }
async function adminAction(env,b,u) {
 const actions=['editMatch','archive','resetVotes','removeVote','clearResult','setTimer','removeMedia','member','settings'];
 if (!actions.includes(b.action)) return null;
 const bad=(error,status=400)=>({status,body:{error}}), ok=()=>({status:200,body:{ok:true}});
 if (!u?.admin) return bad('관리자 인증이 필요합니다.',403);
 if (b.action==='settings') { if (!['heading','tagline'].every(k=>typeof b[k]==='string'&&b[k].trim()&&b[k].length<=120)) return bad('문구는 1~120자로 입력하세요.'); await env.DB.prepare('INSERT OR REPLACE INTO settings(id,data) VALUES(?,?)').bind('site',JSON.stringify({heading:b.heading.trim(),tagline:b.tagline.trim()})).run(); return ok(); }
 if (b.action==='member') { const a=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(b.userId).first(); if(!a)return bad('회원이 없습니다.',404); const name=String(b.name||'').normalize('NFKC').trim(),points=Number(b.points); if(name.length<2||name.length>16||!Number.isSafeInteger(points)||points<0||points>1000000)return bad('닉네임 2~16자, 포인트 0~1,000,000을 입력하세요.'); if(a.admin&&(name!==a.name||b.disabled))return bad('관리자 계정은 변경할 수 없습니다.'); if(b.password&&(typeof b.password!=='string'||b.password.length<8||b.password.length>100))return bad('비밀번호는 8~100자로 입력하세요.'); const duplicate=await env.DB.prepare('SELECT id FROM users WHERE name=? AND id<>?').bind(name,a.id).first(); if(duplicate)return bad('사용 중인 닉네임입니다.',409); const statements=[env.DB.prepare('UPDATE users SET name=?,points=?,disabled=? WHERE id=?').bind(name,points,b.disabled?1:0,a.id)]; if(b.password) statements.push(env.DB.prepare('UPDATE users SET password=? WHERE id=?').bind(await passwordHash(b.password),a.id)); if(b.password||b.disabled)statements.push(env.DB.prepare('DELETE FROM sessions WHERE user=?').bind(a.id)); await env.DB.batch(statements); return ok(); }
 const row=await env.DB.prepare('SELECT data FROM matches WHERE id=?').bind(b.id).first(); if(!row)return bad('경기가 없습니다.',404); const m=JSON.parse(row.data);
 if(b.action==='editMatch'){for(const[k,max]of [['title',70],['a',30],['b',30],['place',70],['rules',30]]){if(typeof b[k]!=='string'||!b[k].trim()||b[k].length>max)return bad('경기 정보를 확인하세요.');m[k]=b[k].trim()}if(!Number.isFinite(Date.parse(b.time)))return bad('경기 시간을 확인하세요.');m.time=b.time;}
 if(b.action==='archive'){m.archived=!!b.archived;if(m.archived){m.closed=true;pauseTimer(m)}}
 if(b.action==='resetVotes')await env.DB.prepare('DELETE FROM votes WHERE match=?').bind(m.id).run();
 if(b.action==='removeVote')await env.DB.prepare('DELETE FROM votes WHERE match=? AND user=?').bind(m.id,b.userId).run();
 if(b.action==='clearResult')m.result='';
 if(b.action==='setTimer'){if(!Number.isInteger(b.round)||b.round<1||b.round>3||!Number.isInteger(b.remaining)||b.remaining<0||b.remaining>70)return bad('라운드 1~3, 남은 시간 0~70초를 입력하세요.');m.timer={round:b.round,remaining:b.remaining,started:null}}
 if(b.action==='removeMedia'){if(!['poster','photoA','photoB','video'].includes(b.field))return bad('잘못된 미디어 항목');m[b.field]=''}
 await storeMatch(env,m); return ok();
}
function fileValid(type,d){if(type==='image/png')return d.length>=8&&d[0]===137&&d[1]===80&&d[2]===78&&d[3]===71;if(type==='image/jpeg')return d[0]===255&&d[1]===216;if(type==='image/webp')return String.fromCharCode(...d.slice(0,4))==='RIFF'&&String.fromCharCode(...d.slice(8,12))==='WEBP';if(type==='video/mp4')return String.fromCharCode(...d.slice(4,8))==='ftyp';if(type==='video/webm')return d[0]===26&&d[1]===69&&d[2]===223&&d[3]===163;return false;}
export default { async fetch(req,env) { try {
 const url=new URL(req.url); if(url.pathname.startsWith('/api/'))await initialize(env); const token=cookie(req), u=await userBySession(env,token);
 if(url.pathname.startsWith('/api/media/')&&req.method==='GET'){const key=url.pathname.split('/').pop(),meta=await env.DB.prepare('SELECT type FROM media WHERE id=?').bind(key).first();if(!meta)return json({error:'파일 없음'},404);const data=await env.MEDIA.get(key,'arrayBuffer');if(!data)return json({error:'파일 없음'},404);const bytes=new Uint8Array(data),range=req.headers.get('range'),h=new Headers({'Content-Type':meta.type,'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'});if(range){const p=/^bytes=(\d*)-(\d*)$/.exec(range);if(!p||!p[1]&&!p[2])return new Response(null,{status:416,headers:{'Content-Range':`bytes */${bytes.length}`}});const start=p[1]?Number(p[1]):Math.max(0,bytes.length-Number(p[2])),end=Math.min(p[1]&&p[2]?Number(p[2]):bytes.length-1,bytes.length-1);if(start>end||start>=bytes.length)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${bytes.length}`}});h.set('Content-Range',`bytes ${start}-${end}/${bytes.length}`);h.set('Content-Length',String(end-start+1));return new Response(bytes.slice(start,end+1),{status:206,headers:h})}return new Response(data,{headers:h});}
 if(url.pathname!=='/api/arena')return env.ASSETS.fetch(req);
 if(req.method==='GET'){const [matches,counts,mine]=await Promise.all([env.DB.prepare('SELECT data FROM matches ORDER BY created DESC').all(),env.DB.prepare('SELECT match AS match_id,side,count(*) AS n FROM votes GROUP BY match,side').all(),u?env.DB.prepare('SELECT match AS match_id,side FROM votes WHERE user=?').bind(u.id).all():{results:[]}]);return json({matches:(matches.results||[]).map(x=>JSON.parse(x.data)).filter(x=>!x.archived),...await adminData(env,u),counts:counts.results||[],mine:mine.results||[],user:u?{name:u.name,points:u.points}:null,signedIn:!!u,admin:!!u?.admin,now:Date.now()});}
 if(req.headers.get('origin')!==url.origin)return json({error:'요청 출처가 올바르지 않습니다.'},403);
 if(req.method==='PUT'){if(!u?.admin)return json({error:'관리자 인증이 필요합니다.'},403);const f=(await req.formData()).get('file');if(!(f instanceof File)||!f.size||f.size>25*1024*1024)return json({error:'Cloudflare 무료 저장 한도에 맞춰 파일은 25MB 이하로 선택하세요.'},400);const data=await f.arrayBuffer(),signature=new Uint8Array(data.slice(0,12));if(!fileValid(f.type,signature))return json({error:'JPG·PNG·WebP·MP4·WebM 형식을 확인하세요.'},400);const key=id();await env.MEDIA.put(key,data);await env.DB.prepare('INSERT INTO media(id,type) VALUES(?,?)').bind(key,f.type).run();return json({url:'/api/media/'+key});}
 if(req.method!=='POST')return json({error:'Method not allowed'},405);const b=await req.json();
 if(['join','login','adminLogin'].includes(b.action)){const name=String(b.action==='adminLogin'?'운영자':b.name||'').normalize('NFKC').trim(),p=String(b.password||'');if(name.length<2||name.length>16||p.length<8||p.length>100)return json({error:'닉네임 2~16자, 비밀번호 8~100자를 입력하세요.'},400);let a=await env.DB.prepare('SELECT * FROM users WHERE name=?').bind(name).first();if(b.action==='join'){if(a)return json({error:'이미 사용 중인 닉네임입니다.'},409);const uid=id();await env.DB.prepare('INSERT INTO users(id,name,password,points,admin,disabled,created) VALUES(?,?,?,?,0,0,?)').bind(uid,name,await passwordHash(p),100,Date.now()).run();a=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();}else if(!a||a.disabled||!(await passwordOk(p,a.password))||(b.action==='adminLogin'&&!a.admin))return json({error:'아이디 또는 비밀번호를 확인하세요.'},401);const raw=crypto.randomUUID()+crypto.randomUUID(),hash=await sha(raw),exp=Date.now()+604800000;await env.DB.prepare('INSERT INTO sessions(token,user,expires) VALUES(?,?,?)').bind(hash,a.id,exp).run();return json({ok:true},200,{'Set-Cookie':`ringside_session=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure`});}
 if(['logout','logoutAdmin'].includes(b.action)){if(token)await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(await sha(token)).run();return json({ok:true},200,{'Set-Cookie':'ringside_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure'});}if(!u)return json({error:'로그인이 필요합니다.'},401);
 if(b.action==='vote'){if(!['a','b'].includes(b.side))return json({error:'선수를 선택하세요.'},400);const match=await env.DB.prepare('SELECT closed,result,archived FROM matches WHERE id=?').bind(b.id).first();if(!match||match.closed||match.result||match.archived)return json({error:'투표가 마감되었습니다.'},409);try{await env.DB.prepare('INSERT INTO votes(user,match,side) VALUES(?,?,?)').bind(u.id,b.id,b.side).run();return json({ok:true})}catch{return json({error:'이미 참여한 경기입니다.'},409)}}
 if(!u.admin)return json({error:'관리자 인증이 필요합니다.'},403);const admin=await adminAction(env,b,u);if(admin)return json(admin.body,admin.status);
 if(b.action==='create'){if(!String(b.a||'').trim()||!String(b.b||'').trim()||!Number.isFinite(Date.parse(b.time)))return json({error:'선수와 시간을 확인하세요.'},400);const m={...seed,id:id(),title:String(b.title||'학교 매치').slice(0,70),a:b.a.trim().slice(0,30),b:b.b.trim().slice(0,30),time:b.time,place:String(b.place||'').slice(0,70),rules:String(b.rules||'킥복싱').slice(0,30),poster:'',photoA:'',photoB:'',video:'',closed:false,result:'',timer:{round:1,remaining:70,started:null}};await env.DB.prepare('INSERT INTO matches(id,data,closed,result,archived,created) VALUES(?,?,0,\'\',0,?)').bind(m.id,JSON.stringify(m),Date.now()).run();return json({ok:true,id:m.id});}
 const row=await env.DB.prepare('SELECT data FROM matches WHERE id=?').bind(b.id).first();if(!row)return json({error:'경기가 없습니다.'},404);const m=JSON.parse(row.data);
 if(b.action==='close'){if(!b.closed&&(m.result||m.timer.started!==null))return json({error:'결과 등록 또는 타이머 실행 중에는 마감 상태를 변경할 수 없습니다.'},409);m.closed=!!b.closed;}
 else if(b.action==='result'){if(!['a','b','draw','cancel'].includes(b.result))return json({error:'결과를 선택하세요.'},400);m.result=b.result;m.closed=true;pauseTimer(m);}
 else if(b.action==='timer'){const t=m.timer,remain=()=>Math.max(0,t.remaining-(t.started===null?0:Math.floor((Date.now()-t.started)/1000)));if(b.command==='start'){if(m.result)return json({error:'결과가 등록된 경기입니다.'},409);if(t.started===null&&t.remaining>0)t.started=Date.now();m.closed=true;}else if(b.command==='pause'){t.remaining=remain();t.started=null;}else if(b.command==='next'){if(remain()!==0||t.round>=3)return json({error:'라운드 종료 후 이동하세요.'},409);m.timer={round:t.round+1,remaining:70,started:null};}else if(b.command==='reset')m.timer={round:1,remaining:70,started:null};else return json({error:'잘못된 명령'},400);}
 else if(b.action==='media'){if(!['poster','photoA','photoB','video'].includes(b.field))return json({error:'잘못된 파일 종류'},400);const key=String(b.url||'').split('/').pop(),f=await env.DB.prepare('SELECT type FROM media WHERE id=?').bind(key).first();if(!f||b.url!=='/api/media/'+key||!(b.field==='video'?f.type.startsWith('video/'):f.type.startsWith('image/')))return json({error:'파일 종류를 확인하세요.'},400);m[b.field]=b.url;}else return json({error:'지원하지 않는 요청'},400);await storeMatch(env,m);return json({ok:true});
 }catch(e){console.error('RINGSIDE request error',e?.message||e);return json({error:'요청을 처리하지 못했습니다.'},500)} } };
