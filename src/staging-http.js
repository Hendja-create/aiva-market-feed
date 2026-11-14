import http from "node:http";

const port = Number(process.env.PORT || 3000);
const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";

const page = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIVA staging · Test HTTP</title>
<style>
body{font:16px system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#172033;background:#f7f8fb}
main{background:white;border:1px solid #e3e7ef;border-radius:16px;padding:24px}
h1{font-size:24px;margin:0 0 8px}p{color:#536078;line-height:1.5}
label{display:block;margin:16px 0 6px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccd3df;border-radius:8px;font:inherit}
button{margin-top:18px;padding:12px 18px;border:0;border-radius:8px;background:#182b4d;color:white;font:inherit;font-weight:600}
button:disabled{opacity:.5}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101827;color:#e9eef8;padding:16px;border-radius:10px;min-height:40px}
small{color:#65718a}
</style></head>
<body><main>
<h1>AIVA · Test de charge staging</h1>
<p>Connecte-toi avec un compte de test créé dans le projet Supabase <b>aiva-staging</b>. Les identifiants sont envoyés directement à Supabase depuis ton navigateur. Le mot de passe et le jeton ne sont ni enregistrés ni transmis à AIVA production.</p>
<form id="login">
<label for="email">E-mail du compte de test</label><input id="email" type="email" autocomplete="username" required>
<label for="password">Mot de passe</label><input id="password" type="password" autocomplete="current-password" required>
<button id="run" type="submit">Lancer le test HTTP</button>
</form>
<p><small>60 lectures au total, 10 par niveau : 1, 2, 4, 8, 16 et 32 requêtes simultanées. Aucun ordre, aucune insertion, aucune modification de données.</small></p>
<pre id="result">En attente du lancement.</pre>
</main>
<script>
const form=document.getElementById('login'),button=document.getElementById('run'),out=document.getElementById('result');
const percentile=(values,p)=>{const a=[...values].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.ceil(p*a.length)-1)]??0};
form.addEventListener('submit',async event=>{
 event.preventDefault();button.disabled=true;out.textContent='Connexion au projet de test…';
 let token='';
 try{
  const cfg=await fetch('/test/config',{cache:'no-store'}).then(r=>r.json());
  if(!cfg.configured)throw new Error('Configuration Supabase incomplète.');
  const login=await fetch(cfg.supabaseUrl+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:cfg.publishableKey,'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value})});
  document.getElementById('password').value='';
  if(!login.ok)throw new Error('Connexion refusée. Vérifie le compte de test du projet aiva-staging.');
  token=(await login.json()).access_token;
  const results=[];
  for(const concurrency of [1,2,4,8,16,32]){
   const durations=[],errors=[];const started=performance.now();let completed=0;
   while(completed<10){
    const count=Math.min(concurrency,10-completed);
    const batch=await Promise.all(Array.from({length:count},async()=>{
     const t=performance.now();
     try{const r=await fetch('/test/db-read',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const b=await r.json();return {ok:r.ok&&b.ok,ms:performance.now()-t,status:r.status}}
     catch{return {ok:false,ms:performance.now()-t,status:0}}
    }));
    for(const item of batch){durations.push(item.ms);if(!item.ok)errors.push(item.status)}
    completed+=count;
   }
   const elapsed=performance.now()-started;
   results.push({concurrency,requests:10,errors:errors.length,p50_ms:+percentile(durations,.50).toFixed(1),p95_ms:+percentile(durations,.95).toFixed(1),p99_ms:+percentile(durations,.99).toFixed(1),throughput_rps:+(10/(elapsed/1000)).toFixed(2)});
   out.textContent=JSON.stringify(results,null,2);
  }
  out.textContent='Test terminé.\n'+JSON.stringify(results,null,2);
 }catch(error){out.textContent='Erreur : '+error.message}
 finally{token='';button.disabled=false}
});
</script></body></html>`;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : "";
}

async function timedFetch(url, options) {
  const started = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(8000)
  });
  return { response, durationMs: Number((performance.now() - started).toFixed(2)) };
}

async function authenticate(token) {
  if (!baseUrl || !publishableKey || !token) {
    return { ok: false, status: 401, reason: "missing_credentials" };
  }
  const { response, durationMs } = await timedFetch(baseUrl + "/auth/v1/user", {
    headers: {
      apikey: publishableKey,
      Authorization: "Bearer " + token
    }
  });
  if (!response.ok) {
    return { ok: false, status: response.status, durationMs };
  }
  const user = await response.json();
  return { ok: Boolean(user?.id), status: response.status, durationMs };
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(page);
  }

  if (req.method === "GET" && path === "/health") {
    return json(res, 200, {
      ok: true,
      service: "aiva-staging-http-probe",
      configured: Boolean(baseUrl && publishableKey),
      supabaseUrlConfigured: Boolean(baseUrl),
      publishableKeyConfigured: Boolean(publishableKey)
    });
  }

  if (req.method === "GET" && path === "/test/config") {
    return json(res, 200, {
      configured: Boolean(baseUrl && publishableKey),
      supabaseUrl: baseUrl || null,
      publishableKey: publishableKey || null
    });
  }

  if (req.method !== "GET" || !["/test/auth", "/test/db-read"].includes(path)) {
    return json(res, 404, { error: "not_found" });
  }

  const token = bearer(req);
  try {
    const auth = await authenticate(token);
    if (!auth.ok) {
      return json(res, auth.status === 401 ? 401 : 502, {
        ok: false,
        stage: "auth",
        status: auth.status,
        durationMs: auth.durationMs ?? null
      });
    }

    if (path === "/test/auth") {
      return json(res, 200, {
        ok: true,
        stage: "auth",
        authDurationMs: auth.durationMs
      });
    }

    const { response, durationMs } = await timedFetch(
      baseUrl + "/rest/v1/aiva_staging_probe?select=id&limit=1",
      {
        headers: {
          apikey: publishableKey,
          Authorization: "Bearer " + token
        }
      }
    );
    if (!response.ok) {
      return json(res, 502, {
        ok: false,
        stage: "db",
        status: response.status,
        authDurationMs: auth.durationMs,
        dbDurationMs: durationMs
      });
    }
    const rows = await response.json();
    return json(res, 200, {
      ok: true,
      stage: "auth+db",
      authDurationMs: auth.durationMs,
      dbDurationMs: durationMs,
      visibleRows: Array.isArray(rows) ? rows.length : null
    });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      stage: "upstream",
      error: error?.name === "TimeoutError" ? "upstream_timeout" : "upstream_error"
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "staging_probe_started", port }));
});
