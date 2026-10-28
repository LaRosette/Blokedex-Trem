import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { createServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { manifestFor } from "./manifests.mjs";
import { packageDirectory } from "./package.mjs";
import {
  accounts,
  addedAccount,
  sitePage,
  releaseFixturesFor,
} from "../tests/fixtures/site.mjs";
import { CONFIG as productionConfig } from "../extension/config.js";

const root = new URL("../", import.meta.url);
const sourceManifest = JSON.parse(
  await readFile(new URL("extension/manifest.json", root), "utf8"),
);
const currentVersion = sourceManifest.version;
const releaseFixtures = releaseFixturesFor(currentVersion);
const nextVersion = releaseFixtures.available.version;
const scratch = new URL(
  `../../../work/firefox-test-${Date.now()}/`,
  import.meta.url,
);
const fixture = new URL("extension/", scratch);
await mkdir(scratch, { recursive: true });
await cp(new URL("extension/", root), fixture, { recursive: true });
let list = { schemaVersion: 1, version: "DEMONSTRATION", accounts };
let release = releaseFixtures.current;
let activeOwner = "CompteDeTest";
let fixtureOptions = {};
const blockedByOwner = new Map();
const avatar = await readFile(new URL("extension/icons/icon16.png", root));
let finish;
const reportReady = new Promise((resolve) => (finish = resolve));
const blocked = [];
let documents = 0;
const heldRequests = new Map();
let shownDialogs = 0;
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/report") {
    let body = "";
    for await (const chunk of request) body += chunk;
    finish(JSON.parse(body));
    response.end("ok");
  } else if (url.pathname === "/mode") {
    const mode = url.searchParams.get("type");
    if (mode.startsWith("update-")) release = releaseFixtures[mode.slice(7)];
    else if (mode === "list-added")
      list = {
        schemaVersion: 1,
        version: mode,
        accounts: [...accounts, addedAccount],
      };
    else if (mode === "list-original" || mode === "list-switch") {
      list = { schemaVersion: 1, version: mode, accounts };
      if (mode === "list-switch") activeOwner = "CompteDeTest";
    } else if (mode === "list-processed")
      blockedByOwner.get(activeOwner).add(addedAccount.username);
    else if (mode === "unblock")
      blockedByOwner.get(activeOwner)?.delete("CompteTest_A");
    else if (mode === "other") activeOwner = "AutreCompte";
    else if (mode === "invalid")
      list = {
        schemaVersion: 1,
        version: "IDENTITE-INCORRECTE",
        accounts: [{ id: "999", username: "CompteTest_A" }],
      };
    else if (mode === "article") {
      fixtureOptions = {
        profileIds: { CompteTest_A: "999" },
        articleFollowIds: { CompteTest_A: "11" },
      };
      list = {
        schemaVersion: 1,
        version: "IDENTITE-ARTICLE",
        accounts: [{ id: "11", username: "CompteTest_A" }],
      };
    } else if (mode === "generic") {
      activeOwner = "CompteSansCache";
      fixtureOptions = { genericUnblockHandles: ["CompteTest_B"] };
      list = {
        schemaVersion: 1,
        version: "DEJA-BLOQUE-SANS-ID",
        accounts: [{ id: "12", username: "CompteTest_B" }],
      };
    } else if (
      [
        "prefix-header",
        "prefix-menu",
        "prefix-dialog",
        "mutated-id",
        "late-dialog",
      ].includes(mode)
    ) {
      activeOwner = "CompteSansCache";
      fixtureOptions = {
        "prefix-header": { headerUsernames: { CompteTest_A: "CompteTest_AB" } },
        "prefix-menu": { menuUsernames: { CompteTest_A: "CompteTest_AB" } },
        "prefix-dialog": { dialogUsernames: { CompteTest_A: "CompteTest_AB" } },
        "mutated-id": { confirmationIds: { CompteTest_A: "999" } },
        "late-dialog": {
          holdDialogHandles: ["CompteTest_A"],
          holdOwnerAfterDialog: true,
        },
      }[mode];
      list = {
        schemaVersion: 1,
        version: mode,
        accounts: [{ id: "11", username: "CompteTest_A" }],
      };
    }
    response.end("ok");
  } else if (["/__test__/dialog", "/__test__/owner"].includes(url.pathname)) {
    heldRequests.set(url.pathname.split("/").at(-1), response);
  } else if (url.pathname === "/__test__/shown") {
    shownDialogs++;
    response.end("ok");
  } else if (url.pathname === "/__test__/signals") {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        held: [...heldRequests.keys()],
        shownDialogs,
        blocked: blocked.length,
        documents,
      }),
    );
  } else if (url.pathname === "/__test__/release") {
    const phase = url.searchParams.get("phase");
    heldRequests.get(phase)?.end("ok");
    heldRequests.delete(phase);
    response.end("ok");
  } else if (url.pathname === "/list.json") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(list));
  } else if (url.pathname === "/updates/latest.json") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(release));
  } else if (url.pathname === "/__test__/blocked") {
    const owner = url.searchParams.get("owner"),
      username = url.searchParams.get("username");
    blocked.push({ owner, username });
    if (!blockedByOwner.has(owner)) blockedByOwner.set(owner, new Set());
    blockedByOwner.get(owner).add(username);
    response.end("ok");
  } else if (url.pathname.startsWith("/profile_images/")) {
    response.setHeader("Content-Type", "image/png");
    response.end(avatar);
  } else {
    if (
      url.pathname === "/home" ||
      [...accounts, addedAccount].some((a) => url.pathname === "/" + a.username)
    )
      documents++;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      sitePage(url.href, activeOwner, {
        ...fixtureOptions,
        avatarOrigin: origin,
        blocked: [...(blockedByOwner.get(activeOwner) || [])],
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const manifest = manifestFor(sourceManifest, "firefox");
manifest.host_permissions = ["http://127.0.0.1/*"];
manifest.content_scripts[0].matches = ["http://127.0.0.1/*"];
// Seule la copie éphémère de test autorise les requêtes vers le serveur local.
manifest.content_security_policy.extension_pages =
  manifest.content_security_policy.extension_pages.replace(
    /connect-src[^;]*/,
    `connect-src ${origin}`,
  );
await writeFile(new URL("manifest.json", fixture), JSON.stringify(manifest));
await writeFile(
  new URL("config.js", fixture),
  `export const CONFIG=${JSON.stringify({ ...productionConfig, listUrl: origin + "/list.json", updatesUrl: origin + "/updates/latest.json" })};`,
);
// La copie de test utilise un site local. Aucun profil X réel n’est visité.
const runner = (await readFile(new URL("runner.js", fixture), "utf8"))
  .replaceAll("https://x.com", origin)
  .replaceAll('"x.com"', '"127.0.0.1"');
await writeFile(new URL("runner.js", fixture), runner);
const originalUpdater = await readFile(new URL("updates.js", fixture), "utf8");
const updater = originalUpdater.replace(
  "`https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/updates/latest.json`",
  JSON.stringify(origin + "/updates/latest.json"),
);
assert.notEqual(
  updater,
  originalUpdater,
  "La vérification de version de test doit utiliser le serveur local.",
);
await writeFile(new URL("updates.js", fixture), updater);
const content = (
  await readFile(new URL("content.js", fixture), "utf8")
).replaceAll('"pbs.twimg.com"', '"127.0.0.1"');
assert.ok(
  content.includes('"127.0.0.1"'),
  "L’avatar de test doit rester sur le serveur local.",
);
await writeFile(new URL("content.js", fixture), content);
const messages = (await readFile(new URL("messages.js", fixture), "utf8"))
  .replace('url.protocol === "https:"', 'url.protocol === "http:"')
  .replace('["x.com", "twitter.com"]', '["127.0.0.1"]')
  .replace("!url.port", `url.port === "${server.address().port}"`);
assert.ok(
  messages.includes('["127.0.0.1"]'),
  "Le routage local du test doit être présent.",
);
await writeFile(new URL("messages.js", fixture), messages);
let background = await readFile(new URL("background.js", fixture), "utf8");
background =
  `
const testApi=globalThis.browser;
const forwardTestMessage=testApi.tabs.sendMessage.bind(testApi.tabs);
const removeTestTab=testApi.tabs.remove.bind(testApi.tabs);
testApi.tabs.remove=async ids=>{
 const {testKeepTab}=await testApi.storage.session.get('testKeepTab');
 if(testKeepTab)throw Error('Fermeture temporairement impossible pour le test d’annulation');
 return removeTestTab(ids);
};
testApi.runtime.onMessage.addListener((message,sender)=>{
 if(sender.id===testApi.runtime.id&&sender.tab&&sender.url?.startsWith(${JSON.stringify(origin + "/")})&&['sessionResult','blockResult','navigateFailed'].includes(message.type)){
  testApi.storage.session.get('testResults').then(({testResults=[]})=>testApi.storage.session.set({testResults:[...testResults,message]}));
 }
});
testApi.tabs.sendMessage=async(id,message)=>{
 if(['navigate','block','abort'].includes(message.type)){
  const {testCommands=[]}=await testApi.storage.session.get('testCommands');
  testCommands.push({type:message.type,jobId:message.jobId,attempt:message.attempt,username:message.account?.username});
  await testApi.storage.session.set({testCommands});
 }
 return forwardTestMessage(id,message);
};
` + background;
background += `\napi.tabs.create({url:api.runtime.getURL('popup.html'),active:true});\n`;

await writeFile(new URL("background.js", fixture), background);
const archive = new URL("test.zip", scratch);
await writeFile(archive, await packageDirectory(fixture));

const options = new firefox.Options()
  .setBrowserVersion("stable")
  .addArguments("-headless");
if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
const html = await readFile(new URL("popup.html", fixture), "utf8");
await writeFile(
  new URL("popup.html", fixture),
  html.replace(
    "</body>",
    '<script type="module" src="test-driver.js"></script></body>',
  ),
);
await writeFile(
  new URL("privacy.html", fixture),
  (await readFile(new URL("privacy.html", fixture), "utf8")) +
    '<script type="module" src="privacy-test.js"></script>',
);
await writeFile(
  new URL("privacy-test.js", fixture),
  `await browser.storage.session.set({testPrivacy:{color:getComputedStyle(document.body).color,stylesheet:[...document.styleSheets].some(sheet=>sheet.href?.endsWith('/privacy.css')&&sheet.cssRules.length>0)}});`,
);
await writeFile(
  new URL("test-driver.js", fixture),
  `
const root=${JSON.stringify(origin)};
const currentVersion=${JSON.stringify(currentVersion)};
const nextVersion=${JSON.stringify(nextVersion)};
const nextReleaseUrl=${JSON.stringify(productionConfig.repoUrl + "/releases/tag/v" + nextVersion)};
const ensure=(condition,message)=>{if(!condition)throw Error(message);};
const readJob=async()=> (await browser.storage.local.get('job')).job;
const waitUI=predicate=>new Promise((resolve,reject)=>{
 const timeout=setTimeout(()=>{observer.disconnect();reject(Error('L’interface Firefox ne répond pas : '+predicate.toString()));},20000);
 const check=()=>{if(predicate()){observer.disconnect();clearTimeout(timeout);resolve();}};
 const observer=new MutationObserver(check);observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true});check();
});
const waitJob=predicate=>new Promise((resolve,reject)=>{
 const clean=()=>{clearTimeout(timeout);browser.storage.onChanged.removeListener(check);};
 const check=async()=>{try{const job=await readJob();if(predicate(job)){clean();resolve(job);}}catch(error){clean();reject(error);}};
 const timeout=setTimeout(()=>{clean();reject(Error('Le traitement Firefox ne répond pas.'));},20000);
 browser.storage.onChanged.addListener(check);check();
});
const navigations=async job=>{
 const {testCommands=[]}=await browser.storage.session.get('testCommands');
 return testCommands.filter(command=>command.jobId===job.id&&command.type==='navigate').map(command=>command.username);
};
const waitClosed=tabId=>new Promise((resolve,reject)=>{
 const clean=()=>{clearTimeout(timeout);browser.tabs.onRemoved.removeListener(removed);};
 const removed=id=>{if(id===tabId){clean();resolve();}};
 const timeout=setTimeout(()=>{clean();reject(Error('L’onglet de travail est resté ouvert.'));},5000);
 browser.tabs.onRemoved.addListener(removed);
 browser.tabs.get(tabId).catch(()=>{clean();resolve();});
});
const waitActive=tabId=>new Promise((resolve,reject)=>{
 const clean=()=>{clearTimeout(timeout);browser.tabs.onActivated.removeListener(activated);};
 const activated=info=>{if(info.tabId===tabId){clean();resolve();}};
 const timeout=setTimeout(()=>{clean();reject(Error('Vérifier X n’a pas activé l’onglet de travail'));},5000);
 browser.tabs.onActivated.addListener(activated);
 browser.tabs.get(tabId).then(tab=>{if(tab.active){clean();resolve();}}).catch(error=>{clean();reject(error);});
});
const run=async(button='start',status='done')=>{
 const previous=(await readJob())?.id;
 if(button==='rescan')document.querySelector('details').open=true;
 await waitUI(()=>!document.getElementById(button).disabled);
 const started=Date.now();document.getElementById(button).click();
 const job=await waitJob(value=>value?.id!==previous&&value?.status===status);
 if(status==='done')await waitClosed(job.tabId);
 await waitUI(()=>!document.getElementById('start').disabled);
 return {job,duration:Date.now()-started};
};
const cancel=async()=>{
 await waitUI(()=>!document.getElementById('cancel').disabled&&!document.getElementById('cancel').hidden);
 document.getElementById('cancel').click();
 await waitJob(job=>job?.status==='cancelled');
 await waitUI(()=>!document.getElementById('start').disabled);
};
const waitBadge=async expected=>{
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){if((await browser.action.getBadgeText({}))===expected)return;await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error('Le badge de nouveaux comptes ne correspond pas à la liste.');
};
const refreshPublishedList=async(mode,count,username)=>{
 await fetch(root+'/mode?type='+mode,{method:'POST'});
 ensure((await browser.runtime.sendMessage({type:'refresh'}))?.ok,'La liste de test ne se recharge pas.');
 await waitBadge(count?String(count):'');
 await waitUI(()=>document.getElementById('listUpdatesNotice').hidden===!count);
 if(count){
  const info=(await browser.runtime.sendMessage({type:'state'})).data.listUpdates;
  ensure(info.count===count&&info.username===username,'Le compteur d’ajouts ne concerne pas le bon compte X.');
  ensure(document.getElementById('listUpdatesCount').textContent==='1 nouveau compte à bloquer'&&document.getElementById('listUpdatesOwner').textContent==='Pour @'+username,'L’encart des nouveaux comptes est incorrect.');
  ensure((await browser.action.getTitle({})).includes('@'+username),'Le titre du badge ne précise pas le compte concerné.');
 }
};
const waitResult=message=>new Promise((resolve,reject)=>{
 const clean=()=>{clearTimeout(timeout);browser.storage.onChanged.removeListener(check);};
 const check=async()=>{const {testResults=[]}=await browser.storage.session.get('testResults');const result=testResults.find(row=>row.jobId===message.jobId&&row.attempt===message.attempt);if(result){clean();resolve(result);}};
 const timeout=setTimeout(()=>{clean();reject(Error('Le script de contenu ne retourne pas le résultat attendu.'));},5000);
 browser.storage.onChanged.addListener(check);check();
});
const signals=async()=> (await fetch(root+'/__test__/signals')).json();
const waitSignals=async predicate=>{
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){const state=await signals();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error('Le site de test ne retourne pas le signal attendu.');
};
const contentCase=async(name,ownerKey)=>{
 await fetch(root+'/mode?type='+name,{method:'POST'});
 const tab=await browser.tabs.create({url:root+'/CompteTest_A',active:false});
 try{
  let connected=false;
  for(let i=0;i<100;i++){
   try{if((await browser.tabs.sendMessage(tab.id,{type:'probe'}))?.owner==='CompteSansCache'){connected=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  ensure(connected,'Le contenu Firefox de test ne répond pas.');
  const message={type:'block',jobId:'security-'+name,attempt:'security-'+name,owner:'CompteSansCache',ownerKey,account:{id:'11',username:'CompteTest_A'}};
  ensure((await browser.tabs.sendMessage(tab.id,message)).accepted,'La commande de test n’a pas été acceptée.');
  const result=await waitResult(message);
  ensure(result.outcome==='error',name+' n’a pas interrompu le blocage.');
  ensure((await signals()).blocked===3,name+' a déclenché un blocage.');
  return result;
 }finally{await browser.tabs.remove(tab.id);}
};
try{
 const refresh=await browser.runtime.sendMessage({type:'refresh'});
 if(!refresh?.ok)throw Error('Chargement de la liste : '+JSON.stringify(refresh));
 await waitUI(()=>document.getElementById('status').textContent.includes('3 comptes dans la liste.'));
 ensure(document.title==='Blokedex-Trem'&&document.querySelector('.brand').textContent.trim()==='Blokedex-Trem'&&document.getElementById('currentVersion').textContent==='v'+currentVersion,'La marque ou la version installée n’est pas affichée.');
 ensure(document.getElementById('updateNotice').hidden,'Une mise à jour inexistante est annoncée.');
 ensure(document.getElementById('listUpdatesNotice').hidden,'Une première installation ne doit pas annoncer de nouveaux comptes.');
 await waitBadge('');
 await fetch(root+'/mode?type=update-available',{method:'POST'});
 await waitUI(()=>!document.getElementById('checkUpdate').disabled);
 document.getElementById('checkUpdate').click();
 await waitUI(()=>!document.getElementById('updateNotice').hidden);
 ensure(document.getElementById('updateLink').href===nextReleaseUrl&&document.getElementById('updateLink').textContent==='Voir la version '+nextVersion,'Le lien de la nouvelle version n’est pas celui de la release GitHub validée.');
 ensure(!document.getElementById('start').disabled,'La recherche de mise à jour empêche le blocage.');
 await fetch(root+'/mode?type=update-injected',{method:'POST'});
 await browser.storage.local.remove(['latestRelease','updateCheckedAt','updateError']);
 await waitUI(()=>!document.getElementById('checkUpdate').disabled);
 document.getElementById('checkUpdate').click();
 await waitUI(()=>document.getElementById('updateNotice').hidden&&document.getElementById('updateStatus').textContent.includes('Vérification indisponible'));
 ensure(!document.getElementById('updateLink').hasAttribute('href')&&globalThis.__releaseInjection!==true,'Les métadonnées de version injectées ont créé du HTML ou un lien arbitraire.');
 await fetch(root+'/mode?type=update-current',{method:'POST'});
 await waitUI(()=>!document.getElementById('checkUpdate').disabled);
 document.getElementById('checkUpdate').click();
 await waitUI(()=>document.getElementById('updateStatus').textContent.includes('Aucune nouvelle version publiée'));
 ensure(document.getElementById('updateNotice').hidden,'La même version ne doit pas afficher de nouveauté.');
 const violation=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('La CSP Firefox n’a pas bloqué la connexion hors liste.')),3000);
  addEventListener('securitypolicyviolation',event=>{if(event.blockedURI==='https://example.invalid/security-probe'){clearTimeout(timeout);resolve(event.effectiveDirective);}});
 });
 await fetch('https://example.invalid/security-probe').catch(()=>{});
 ensure((await violation)==='connect-src','La connexion hors liste n’a pas été bloquée par connect-src.');
 const privacyTab=await browser.tabs.create({url:browser.runtime.getURL('privacy.html'),active:false});
 const privacy=await new Promise((resolve,reject)=>{
  const clean=()=>{clearTimeout(timeout);browser.storage.onChanged.removeListener(check);};
  const check=async()=>{const {testPrivacy}=await browser.storage.session.get('testPrivacy');if(testPrivacy){clean();resolve(testPrivacy);}};
  const timeout=setTimeout(()=>{clean();reject(Error('La page confidentialité ne répond pas.'));},5000);
  browser.storage.onChanged.addListener(check);check();
 });
 ensure(privacy.color==='rgb(24, 63, 53)'&&privacy.stylesheet,'La feuille de style confidentialité n’a pas chargé sous CSP stricte.');
 await browser.tabs.remove(privacyTab.id);
 const first=await run(), job=first.job;
 ensure(job.owner==='CompteDeTest'&&/^[a-f0-9]{64}$/.test(job.ownerKey),'Compte connecté non identifié');
 ensure(job.created===1&&job.already===1&&job.cached===0&&job.failed.length===1,'Premier bilan incorrect');
 ensure(JSON.stringify(await navigations(job))===JSON.stringify(['CompteTest_A','CompteTest_B','CompteTest_C']),'Premier parcours incomplet');
 await fetch(root+'/mode?type=unblock',{method:'POST'});
 const cached=await run();
 ensure(cached.job.cached===2&&cached.job.created===0&&cached.job.already===0&&cached.job.failed.length===1,'Le cache n’a pas sauté les comptes déjà traités');
 ensure(JSON.stringify(await navigations(cached.job))===JSON.stringify(['CompteTest_C']),'Le cache recharge des profils confirmés');
 const rescan=await run('rescan');
 ensure(rescan.job.force&&rescan.job.cached===0&&rescan.job.created===1&&rescan.job.already===1,'Tout revérifier ne réapplique pas le blocage retiré');
 ensure((await navigations(rescan.job)).length===3,'La vérification complète n’a pas parcouru la liste');
 await fetch(root+'/mode?type=other',{method:'POST'});
 const other=await run();
 ensure(other.job.owner==='AutreCompte'&&/^[a-f0-9]{64}$/.test(other.job.ownerKey)&&other.job.ownerKey!==job.ownerKey,'Les comptes connectés ne sont pas cloisonnés');
 ensure(other.job.cached===0&&other.job.created===1&&other.job.already===1,'Le second compte utilise le cache du premier');
 const {processedHistory}=await browser.storage.local.get('processedHistory');
 ensure(processedHistory.length===2&&processedHistory.every(row=>row.ids.length===2),'Historique local incorrect');
 await refreshPublishedList('list-original',0);
 await refreshPublishedList('list-added',1,'AutreCompte');
 await refreshPublishedList('list-added',1,'AutreCompte');
 await refreshPublishedList('list-original',0);
 await refreshPublishedList('list-added',1,'AutreCompte');
 await fetch(root+'/mode?type=list-processed',{method:'POST'});
 const additions=await run();
 ensure(additions.job.confirmed===3&&additions.job.cached===2&&additions.job.already===1&&additions.job.created===0,'Le nouveau profil n’a pas été confirmé sans action inutile.');
 await waitBadge('');
 await waitUI(()=>document.getElementById('listUpdatesNotice').hidden);
 await refreshPublishedList('list-switch',0);
 const selected=await run();
 ensure(selected.job.owner==='CompteDeTest'&&selected.job.cached===2,'Le second compte X n’a pas été sélectionné.');
 await refreshPublishedList('list-added',1,'CompteDeTest');
 await refreshPublishedList('list-original',0);
 await fetch(root+'/mode?type=invalid',{method:'POST'});
 const invalid=await run('start','paused');
 ensure(invalid.job.confirmed===0&&invalid.job.message.includes('vérifier l’identité'),'L’identifiant incorrect n’a pas été refusé');
 document.getElementById('inspect').click();
 await waitActive(invalid.job.tabId);
 ensure((await browser.tabs.get(invalid.job.tabId)).active,'Vérifier X n’a pas activé l’onglet de travail');
 await cancel();
 await fetch(root+'/mode?type=article',{method:'POST'});
 const article=await run('rescan','paused');
 ensure(article.job.confirmed===0&&article.job.message.includes('vérifier l’identité'),'Un identifiant dans un article a validé le mauvais profil');
 await cancel();
 await fetch(root+'/mode?type=generic',{method:'POST'});
 const generic=await run();
 ensure(generic.job.owner==='CompteSansCache'&&generic.job.confirmed===1&&generic.job.already===1&&generic.job.created===0&&generic.job.cached===0&&generic.job.failed.length===0,'Le profil déjà bloqué sans identifiant n’a pas été sauté sans action');
 ensure(JSON.stringify(await navigations(generic.job))===JSON.stringify(['CompteTest_B']),'Le profil générique n’a pas été consulté');
 const {processedHistory:genericHistory=[]}=await browser.storage.local.get('processedHistory');
 ensure(!genericHistory.some(row=>row.key===generic.job.ownerKey||row.username==='CompteSansCache'),'Le profil déjà bloqué sans identifiant a alimenté le cache');
 await contentCase('prefix-header',generic.job.ownerKey);
 await contentCase('prefix-menu',generic.job.ownerKey);
 await contentCase('prefix-dialog',generic.job.ownerKey);
 const mutated=await contentCase('mutated-id',generic.job.ownerKey);
 ensure(mutated.code==='identity','L’identité numérique n’a pas été revérifiée avant confirmation.');
 await fetch(root+'/mode?type=late-dialog',{method:'POST'});
 await browser.storage.session.set({testKeepTab:true});
 const beforeLate=await signals();
 await waitUI(()=>!document.getElementById('start').disabled);
 document.getElementById('start').click();
 await waitSignals(state=>state.held.includes('dialog'));
 const late=await readJob();
 ensure(late.status==='running'&&late.confirmed===0,'Le travail de test n’attend pas le dialogue.');
 try{await browser.runtime.sendMessage({type:'blockResult',jobId:late.id,attempt:late.attempt,outcome:'blocked'});}catch{}
 const unchanged=await readJob();
 ensure(unchanged.status==='running'&&unchanged.confirmed===0,'Le popup a pu forger un résultat de contenu.');
 await cancel();
 const {testCommands:commandsAfterCancel=[]}=await browser.storage.session.get('testCommands');
 ensure(commandsAfterCancel.some(command=>command.type==='abort'&&command.jobId===late.id&&command.attempt===late.attempt),'Arrêter n’a pas envoyé abort à la tentative courante.');
 ensure(!!(await browser.tabs.get(late.tabId)),'Le document doit rester ouvert pour tester le dialogue tardif.');
 await fetch(root+'/__test__/release?phase=dialog',{method:'POST'});
 await waitSignals(state=>state.shownDialogs===beforeLate.shownDialogs+1&&state.held.includes('owner'));
 ensure((await signals()).blocked===3,'Le dialogue apparu après Arrêter a été confirmé.');
 const newTask={type:'inspect',jobId:'security-new-task',attempt:'security-new-attempt'};
 ensure((await browser.tabs.sendMessage(late.tabId,newTask)).accepted,'La nouvelle tâche a été refusée après annulation.');
 const staleAbort=await browser.tabs.sendMessage(late.tabId,{type:'abort',jobId:late.id,attempt:late.attempt});
 ensure(staleAbort.aborted===false,'L’annulation d’une ancienne tentative a invalidé une nouvelle tâche.');
 await fetch(root+'/__test__/release?phase=owner',{method:'POST'});
 const newResult=await waitResult(newTask);
 ensure(newResult.type==='sessionResult'&&newResult.owner==='CompteSansCache','La nouvelle tâche n’a pas terminé après une annulation ancienne.');
 const {testResults:allResults=[]}=await browser.storage.session.get('testResults');
 ensure(!allResults.some(row=>row.type==='blockResult'&&row.jobId===late.id&&row.attempt===late.attempt),'La tentative annulée a émis un résultat tardif.');
 const afterLate=await signals();
 ensure(afterLate.blocked===3&&afterLate.documents-beforeLate.documents===1,'Le scénario d’annulation a bloqué ou rechargé un profil.');
 await browser.storage.session.set({testKeepTab:false});
 await browser.tabs.remove(late.tabId);
 await fetch(root+'/report',{method:'POST',body:JSON.stringify({ok:true,duration:first.duration,cachedDuration:cached.duration,rescanDuration:rescan.duration,job})});
}catch(error){const {job}=await browser.storage.local.get('job');let tab;try{tab=await browser.tabs.get(job.tabId);}catch{}const permissions=await browser.permissions.getAll();await fetch(root+'/report',{method:'POST',body:JSON.stringify({ok:false,error:error.message,text:document.body.innerText,job,tab,permissions})});}
`,
);
await writeFile(archive, await packageDirectory(fixture));
let driver, timeout;
try {
  driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();
  await driver.installWebExtension(fileURLToPath(archive), {
    permanent: false,
  });
  const result = await Promise.race([
    reportReady,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(Error("Le test Firefox ne répond pas.")),
        45000,
      );
    }),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(blocked, [
    { owner: "CompteDeTest", username: "CompteTest_A" },
    { owner: "CompteDeTest", username: "CompteTest_A" },
    { owner: "AutreCompte", username: "CompteTest_A" },
  ]);
  assert.equal(
    documents,
    14,
    "Les dix lots et les quatre scénarios de contenu doivent charger chacun un seul document",
  );
  const report = {
    date: new Date().toISOString(),
    browser: "Firefox",
    version: (await driver.getCapabilities()).get("browserVersion"),
    network: "Site local et profils fictifs, aucun blocage réel",
    batchDurationMs: result.duration,
    cachedBatchDurationMs: result.cachedDuration,
    rescanDurationMs: result.rescanDuration,
    checks: [
      "installation du paquet Firefox",
      "module de fond et API browser natives",
      "liste distante",
      "bouton de lancement",
      "confirmation du blocage",
      "compte déjà bloqué",
      "profil indisponible",
      "fermeture de l’onglet de travail",
      "refus d’une identité incorrecte",
      "arrêt du traitement",
      "navigation interne sans recharger X entre les profils",
      "identité locale cloisonnée par compte connecté",
      "profil valide sans publication traité correctement",
      "second passage : deux comptes confirmés sautés sans navigation",
      "Tout revérifier réapplique un blocage retiré manuellement",
      "autre compte X : aucun cache partagé",
      "identifiant trouvé dans un article refusé comme identité du profil",
      "profil déjà bloqué sans identifiant numérique sauté sans action et sans cache",
      "pseudo plus long refusé dans l’en-tête du profil",
      "pseudo plus long refusé dans le menu Bloquer",
      "pseudo plus long refusé dans le dialogue de confirmation",
      "identifiant numérique modifié avant confirmation : aucun clic",
      "annulation pendant l’attente : dialogue tardif jamais confirmé",
      "annulation d’une ancienne tentative sans effet sur une nouvelle tâche",
      "résultat de contenu forgé depuis le popup refusé",
      "CSP : connexion hors liste bloquée par connect-src",
      "page confidentialité et feuille de style externe chargées sous CSP stricte",
      "marque Blokedex-Trem et version installée affichées",
      "version supérieure au manifeste signalée avec lien GitHub construit et validé",
      "métadonnées de version injectées refusées sans HTML ni lien arbitraire",
      "première installation et anciens profils indisponibles sans fausse alerte",
      "ajout de liste signalé ; retrait et liste égale sans compteur persistant",
      "nouveaux profils cloisonnés par dernier compte X explicitement confirmé",
      "fin du traitement des ajouts : encart et badge effacés",
    ],
    result: "34 contrôles réussis",
  };
  await mkdir(new URL("verification/", root), { recursive: true });
  await writeFile(
    new URL("verification/firefox.json", root),
    JSON.stringify(report, null, 2),
  );
  console.log("34 contrôles Firefox réussis (" + report.version + ").");
} finally {
  clearTimeout(timeout);
  await driver?.quit();
  await new Promise((resolve) => server.close(resolve));
}
