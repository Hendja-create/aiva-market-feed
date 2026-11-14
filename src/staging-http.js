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
<button id="run" type="button" onclick="const e=document.getElementById('email').value.trim(),p=document.getElementById('password').value,o=document.getElementById('result');if(!e||!p){o.textContent='Saisis l’e-mail et le mot de passe du compte de test.';}else if(typeof window.aivaRunBenchmark==='function'){window.aivaRunBenchmark();}else{o.textContent='Erreur : le script du benchmark ne s’est pas initialisé. Recharge la page et consulte la console.';}">Lancer le test HTTP</button>
</form>
<p><small>Benchmark renforcé : 100 lectures par niveau, 3 répétitions, concurrence 1, 2, 4, 8, 16 et 32 (1 800 lectures au total). Lectures uniquement : aucun ordre, aucune insertion, aucune modification de données. Prévoir environ 8 à 10 minutes.</small></p>
<pre id="result">En attente du lancement.</pre>
<noscript><p style="color:#b42318;font-weight:700">JavaScript est désactivé dans ce navigateur. Active-le pour lancer le test.</p></noscript>
</main>
<script>
window.aivaRunBenchmark = async function () {
  var email = document.getElementById("email").value.trim();
  var password = document.getElementById("password").value;
  var button = document.getElementById("run");
  var out = document.getElementById("result");
  if (!email || !password) {
    out.textContent = "Saisis l’e-mail et le mot de passe du compte de test.";
    return;
  }
  button.disabled = true;
  out.textContent = "Étape 1/2 : connexion au projet de test…";
  var token = "";
  var levels = [1, 2, 4, 8, 16, 32];
  var results = [];
  var total = 1800;
  var finished = 0;
  function percentile(values, p) {
    if (!values.length) return 0;
    values.sort(function(a,b){ return a-b; });
    return values[Math.min(values.length-1, Math.ceil(p*values.length)-1)];
  }
  function wait(ms) { return new Promise(function(resolve){ setTimeout(resolve,ms); }); }
  try {
    var cfgResponse = await fetch("/test/config", {cache:"no-store"});
    var cfg = await cfgResponse.json();
    if (!cfg.configured) throw new Error("Configuration Supabase incomplète.");
    var loginResponse = await fetch(cfg.supabaseUrl + "/auth/v1/token?grant_type=password", {
      method:"POST",
      headers:{apikey:cfg.publishableKey,"Content-Type":"application/json"},
      body:JSON.stringify({email:email,password:password})
    });
    document.getElementById("password").value = "";
    if (!loginResponse.ok) throw new Error("Connexion refusée. Vérifie le compte de test du projet aiva-staging.");
    var loginData = await loginResponse.json();
    token = loginData.access_token;
    if (!token) throw new Error("Supabase n’a pas retourné de jeton de session.");
    for (var repetition=1; repetition<=3; repetition++) {
      for (var li=0; li<levels.length; li++) {
        var concurrency = levels[li];
        var durations=[], authDurations=[], dbDurations=[], errors=0;
        var started=performance.now();
        var completed=0;
        while (completed<100) {
          var count=Math.min(concurrency,100-completed);
          var jobs=[];
          for (var j=0;j<count;j++) {
            jobs.push((async function(){
              var t=performance.now();
              try {
                var response=await fetch("/test/db-read",{headers:{Authorization:"Bearer "+token},cache:"no-store"});
                var body=await response.json();
                return {ok:response.ok && body.ok,ms:performance.now()-t,status:response.status,authMs:body.authDurationMs,dbMs:body.dbDurationMs};
              } catch(e) { return {ok:false,ms:performance.now()-t,status:0}; }
            })());
          }
          var batch=await Promise.all(jobs);
          for(var k=0;k<batch.length;k++) {
            var item=batch[k]; durations.push(item.ms);
            if(!item.ok) errors++;
            if(typeof item.authMs==="number") authDurations.push(item.authMs);
            if(typeof item.dbMs==="number") dbDurations.push(item.dbMs);
          }
          completed+=count; finished+=count;
          out.textContent="Benchmark en cours : répétition "+repetition+"/3, concurrence "+concurrency+", "+finished+"/"+total+" lectures terminées.";
        }
        var elapsed=performance.now()-started;
        results.push({
          repetition:repetition,concurrency:concurrency,requests:100,errors:errors,
          p50_ms:+percentile(durations,.50).toFixed(1),
          p95_ms:+percentile(durations,.95).toFixed(1),
          p99_ms:+percentile(durations,.99).toFixed(1),
          auth_p50_ms:+percentile(authDurations,.50).toFixed(1),
          db_p50_ms:+percentile(dbDurations,.50).toFixed(1),
          throughput_rps:+(100/(elapsed/1000)).toFixed(2)
        });
        out.textContent="Benchmark en cours : "+finished+"/"+total+" lectures terminées.\n"+JSON.stringify(results,null,2);
        await wait(1500);
      }
    }
    out.textContent="Benchmark terminé : "+finished+"/"+total+" lectures.\n"+JSON.stringify(results,null,2);
  } catch(error) {
    out.textContent="Erreur : "+(error && error.message ? error.message : "échec inattendu");
  } finally {
    token="";
    button.disabled=false;
  }
};
window.aivaScriptLoaded = true;
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
