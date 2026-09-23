'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load a local .env without adding another package. Render environment variables still win.
const ENV_FILE = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const rawLine of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const app = express();
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'responses.json');
const PORT = Number(process.env.PORT) || 3001;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'thara';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'thara2008';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '');
const SUPABASE_TABLE = String(process.env.SUPABASE_TABLE || 'love_responses').replace(/[^a-zA-Z0-9_]/g, '') || 'love_responses';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);
const adminTokens = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]\n', 'utf8');

app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({limit:'128kb'}));
app.use('/assets', express.static(path.join(ROOT,'assets'), {maxAge:'7d', etag:true}));

function readResponses(){
  try{ const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); return Array.isArray(data)?data:[]; }
  catch{return [];}
}
function writeResponses(rows){
  const tmp=DATA_FILE+'.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows,null,2)+'\n','utf8');
  fs.renameSync(tmp,DATA_FILE);
}
function cleanText(value,max=240){return String(value??'').trim().slice(0,max);}
function safeEqual(a,b){ const aa=Buffer.from(String(a));const bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function requireAdmin(req,res,next){
  const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const expires=adminTokens.get(token);
  if(!expires || expires<Date.now()){
    if(token) adminTokens.delete(token);
    return res.status(401).json({error:'Unauthorized'});
  }
  next();
}
function supabaseHeaders(extra={}){
  return {'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json',...extra};
}
async function saveToSupabase(row){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`,{method:'POST',headers:supabaseHeaders({'Prefer':'return=minimal'}),body:JSON.stringify(row)});
  if(!r.ok) throw new Error(`Supabase insert failed: ${r.status} ${await r.text()}`);
}
async function readFromSupabase(){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?select=id,created_at,answers&order=created_at.desc`,{headers:supabaseHeaders({'x-admin-secret':ADMIN_PASSWORD})});
  if(!r.ok) throw new Error(`Supabase read failed: ${r.status} ${await r.text()}`);
  const rows=await r.json();
  return rows.map(row=>({id:row.id,createdAt:row.created_at,answers:row.answers}));
}
async function deleteFromSupabase(id){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',headers:supabaseHeaders({'Prefer':'return=minimal','x-admin-secret':ADMIN_PASSWORD})});
  if(!r.ok) throw new Error(`Supabase delete failed: ${r.status} ${await r.text()}`);
}

async function migrateLocalResponsesToSupabase(){
  if(!USE_SUPABASE) return {migrated:0};
  const local=readResponses();
  if(!local.length) return {migrated:0};
  const rows=local.map(row=>({
    id: row.id || crypto.randomUUID(),
    created_at: row.created_at || row.createdAt || new Date().toISOString(),
    answers: Array.isArray(row.answers)?row.answers:[]
  })).filter(row=>row.answers.length);
  if(!rows.length) return {migrated:0};
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=id`,{
    method:'POST',
    headers:supabaseHeaders({'Prefer':'resolution=ignore-duplicates,return=minimal'}),
    body:JSON.stringify(rows)
  });
  if(!r.ok) throw new Error(`Supabase migration failed: ${r.status} ${await r.text()}`);
  return {migrated:rows.length};
}

app.get('/health',(req,res)=>res.json({status:'ok',version:'3.3.0',database:USE_SUPABASE?'supabase':'local-fallback'}));

app.post('/api/love/submit',async(req,res)=>{
  try{
    const input=Array.isArray(req.body?.answers)?req.body.answers:[];
    if(input.length<1 || input.length>12) return res.status(400).json({error:'Invalid answers'});
    const answers=input.map(item=>({question:cleanText(item?.question),answer:cleanText(item?.answer)})).filter(x=>x.question&&x.answer);
    if(answers.length!==input.length) return res.status(400).json({error:'Invalid answer content'});
    const row={id:crypto.randomUUID(),created_at:new Date().toISOString(),answers};
    if(USE_SUPABASE){
      await saveToSupabase(row);
    } else {
      const rows=readResponses();
      rows.unshift({id:row.id,createdAt:row.created_at,answers});
      writeResponses(rows); // preserve every old + new response; no automatic trimming
    }
    res.status(201).json({success:true,database:USE_SUPABASE?'supabase':'local-fallback'});
  }catch(err){ console.error(err); res.status(500).json({error:'Could not save response'}); }
});

app.post('/api/admin/login',(req,res)=>{
  const username=cleanText(req.body?.username,120);
  const password=cleanText(req.body?.password,120);
  if(!safeEqual(username,ADMIN_USERNAME) || !safeEqual(password,ADMIN_PASSWORD)) return res.status(401).json({error:'Invalid credentials'});
  const token=crypto.randomBytes(32).toString('hex');
  adminTokens.set(token,Date.now()+4*60*60*1000);
  res.json({token,expiresIn:14400});
});

app.post('/api/admin/migrate',requireAdmin,async(req,res)=>{
  try{
    const result=await migrateLocalResponsesToSupabase();
    res.json({success:true,...result});
  }catch(err){ console.error(err); res.status(500).json({error:'Could not migrate old responses'}); }
});

app.get('/api/admin/responses',requireAdmin,async(req,res)=>{
  try{ res.json({responses:USE_SUPABASE?await readFromSupabase():readResponses(),database:USE_SUPABASE?'supabase':'local-fallback'}); }
  catch(err){ console.error(err); res.status(500).json({error:'Could not load responses'}); }
});

app.delete('/api/admin/responses/:id',requireAdmin,async(req,res)=>{
  try{
    const id=cleanText(req.params.id,80);
    if(!id) return res.status(400).json({error:'Invalid response id'});
    if(USE_SUPABASE){
      await deleteFromSupabase(id);
    } else {
      const rows=readResponses();
      const next=rows.filter(row=>String(row.id)!==id);
      if(next.length===rows.length) return res.status(404).json({error:'Response not found'});
      writeResponses(next);
    }
    res.json({success:true});
  }catch(err){ console.error(err); res.status(500).json({error:'Could not delete response'}); }
});

app.get('/',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));
app.get('*',(req,res)=>{ if(req.path.startsWith('/api/')) return res.status(404).json({error:'Not found'}); res.sendFile(path.join(ROOT,'index.html')); });
app.use((err,req,res,next)=>{ console.error(err); if(res.headersSent) return next(err); res.status(500).json({error:'Server error'}); });
app.listen(PORT,async()=>{
  console.log(`🎂 Buji HDB v3.3 running on http://localhost:${PORT} | DB: ${USE_SUPABASE?'Supabase':'local fallback'}`);
  if(USE_SUPABASE){
    try{
      const result=await migrateLocalResponsesToSupabase();
      if(result.migrated) console.log(`[migration] Preserved ${result.migrated} local response(s) in Supabase (duplicates ignored).`);
    }catch(err){ console.error('[migration] Old response migration skipped:',err.message); }
  }
});
