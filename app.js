/* HEJ unterwegs – Erfassung auf der Baustelle (ohne Server, alles auf dem Gerät).
 * Daten: IndexedDB. Austausch: Baustellen-Paket laden (ZIP), Erfassung abgeben (ZIP über Teilen-Menü). */
"use strict";

/* ---------- Hilfen ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const today = () => localIso(new Date()).slice(0, 10);
const deDate = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}.${m}.${y}`; };
const yymmdd = (d) => `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const slug = (s) => String(s || "Projekt").replace(/[äöüÄÖÜß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" }[c])).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "Projekt";
const KINDS = { mangel: "Mangel", restleistung: "Restleistung", klaerung: "Klärung", hinweis: "Hinweis" };
const PRIOS = ["niedrig", "mittel", "hoch"];
const WEATHER = ["", "sonnig", "heiter", "wolkig", "bedeckt", "Regen", "Schauer", "Schnee", "Nebel", "Sturm", "Frost"];

/* ---------- Speicher (IndexedDB) ---------- */
let dbPromise;
const db = () => (dbPromise ||= new Promise((resolve, reject) => {
  const r = indexedDB.open("hej-mobil", 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore("projects", { keyPath: "id" });
    d.createObjectStore("planimgs");
    d.createObjectStore("captures", { keyPath: "id" });
    d.createObjectStore("photos", { keyPath: "id" });
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
}));
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbGet = async (store, key) => req((await db()).transaction(store).objectStore(store).get(key));
const dbAll = async (store) => req((await db()).transaction(store).objectStore(store).getAll());
const dbWrite = async (store, fn) => {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, "readwrite"); fn(t.objectStore(store)); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
};
const dbPut = (store, val, key) => dbWrite(store, (s) => (key === undefined ? s.put(val) : s.put(val, key)));
const dbDel = (store, key) => dbWrite(store, (s) => s.delete(key));
const capturesOf = async (projectId) => (await dbAll("captures")).filter((c) => c.projectId === projectId);

/* ---------- Fotos ---------- */
function loadImg(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Bild nicht lesbar")); };
    img.src = url;
  });
}
/** Verkleinert ein Foto (längste Seite max. 2000 px, JPEG) und beachtet die Aufnahmerichtung. */
async function processImage(file, max = 2000) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { src = await loadImg(file); }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
  if (!blob) throw new Error("Foto konnte nicht verkleinert werden");
  return { blob, takenAt: localIso(new Date(file.lastModified || Date.now())) };
}
async function addPhotoFiles(files, draft) {
  const failed = [];
  for (const f of files) {
    try {
      const { blob, takenAt } = await processImage(f);
      const id = uid();
      await dbPut("photos", { id, blob, takenAt });
      draft.photos.push({ id, takenAt });
      draft.added.push(id);
    } catch { failed.push(f.name || "Foto"); }
  }
  return failed;
}
const thumbUrls = new Map();
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const rec = await dbGet("photos", id);
  const url = rec ? URL.createObjectURL(rec.blob) : "";
  thumbUrls.set(id, url);
  return url;
}

/* ---------- Oberfläche ---------- */
const app = $("#app");
let cleanup = null;
const go = (hash) => { location.hash = hash; };
const header = (title, back, extra = "") => `<header class="top">${back !== undefined && back !== null ? `<button class="back" data-back="${esc(back)}" aria-label="Zurück">‹</button>` : ""}<h1>${esc(title)}</h1>${extra}</header>`;

function showError(msg) { const d = document.createElement("div"); d.className = "toast err"; d.textContent = msg; document.body.append(d); setTimeout(() => d.remove(), 5000); }

async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  try {
    if (parts[0] === "p" && parts[1]) {
      if (parts[2] === "plan" && parts[3]) return await viewPlan(parts[1], parts[3]);
      if (parts[2] === "diary") return await viewDiary(parts[1], parts[3]);
      return await viewProject(parts[1]);
    }
    return await viewHome();
  } catch (e) {
    app.innerHTML = `${header("HEJ unterwegs")}<main><p class="err">Das hat nicht geklappt: ${esc(e.message || e)}</p><button class="btn block" data-back="">Zur Startseite</button></main>`;
    bindBack();
  }
}
function bindBack() { $$("[data-back]").forEach((b) => b.addEventListener("click", () => go(b.dataset.back ? `#/${b.dataset.back}` : "#/"))); }
window.addEventListener("hashchange", route);

/* ---------- Start ---------- */
/** Nur für die Vorschau: legt ein Beispielprojekt an, wenn die Seite mit window.HEJ_DEMO geladen wird. */
async function seedDemo() {
  const d = window.HEJ_DEMO;
  if (!d || (await dbAll("projects")).length) return;
  const bin = atob(d.planBase64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await dbPut("planimgs", new Blob([bytes], { type: "image/jpeg" }), `${d.project.id}:${d.plan.id}`);
  await dbPut("projects", { id: d.project.id, name: d.project.name, code: d.project.code, plans: [d.plan], defects: d.defects, trades: d.trades, createdAt: new Date().toISOString(), loadedAt: new Date().toISOString() });
}

async function viewHome() {
  await seedDemo();
  const projects = (await dbAll("projects")).sort((a, b) => a.name.localeCompare(b.name, "de"));
  const caps = await dbAll("captures");
  const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  app.innerHTML = `
    <header class="top"><span class="brand">HEJ.</span><span class="sub">unterwegs</span></header>
    <main>
      <h2>Projekte auf diesem Gerät</h2>
      ${projects.length ? `<div class="list">${projects.map((p) => {
        const n = caps.filter((c) => c.projectId === p.id && !c.handedOver).length;
        return `<button class="row" data-open="${esc(p.id)}"><span class="grow">${esc(p.name)}<small>${p.plans.length} Pläne · Stand ${esc(deDate(p.createdAt || p.loadedAt))}</small></span>${n ? `<span class="badge">${n}</span>` : ""}<span class="chev">›</span></button>`;
      }).join("")}</div>` : `<p class="empty">Noch kein Projekt geladen. Erzeuge in HEJ am Mac unter „Unterwegs“ ein Baustellen-Paket, lege es per AirDrop oder Synology Drive aufs Gerät und lade es hier.</p>`}
      <label class="btn primary block">Baustellen-Paket laden<input id="pkg" type="file" hidden></label>
      <div id="msg"></div>
      ${standalone ? "" : `<p class="note">Für die Nutzung ohne Netz: In Safari auf Teilen tippen und „Zum Home-Bildschirm“ wählen, dann von dort öffnen.</p>`}
      <p class="note">${est && est.usage != null ? `Belegt auf dem Gerät: ${(est.usage / 1048576).toFixed(0)} MB. ` : ""}Version 1</p>
    </main>`;
  $$("[data-open]").forEach((b) => b.addEventListener("click", () => go(`#/p/${b.dataset.open}`)));
  $("#pkg").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    $("#msg").innerHTML = `<p class="note">Paket wird gelesen …</p>`;
    try { const p = await loadPackage(f); $("#msg").innerHTML = `<p class="ok">„${esc(p.name)}“ geladen: ${p.plans.length} Pläne, ${p.defects.length} offene Punkte.</p>`; setTimeout(route, 900); }
    catch (err) { $("#msg").innerHTML = `<p class="err">${esc(err.message || "Das Paket konnte nicht gelesen werden.")}</p>`; }
  });
  navigator.storage?.persist?.().catch(() => {});
}

async function loadPackage(file) {
  let files;
  try { files = fflate.unzipSync(new Uint8Array(await file.arrayBuffer())); } catch { throw new Error("Die Datei ist kein gültiges Paket."); }
  if (!files["manifest.json"]) throw new Error("Das ist kein HEJ-Baustellen-Paket.");
  const m = JSON.parse(fflate.strFromU8(files["manifest.json"]));
  if (m.format !== "hej-paket") throw new Error("Das ist kein HEJ-Baustellen-Paket.");
  const old = await dbGet("projects", m.project.id);
  if (old) for (const pl of old.plans) await dbDel("planimgs", `${old.id}:${pl.id}`);
  for (const pl of m.plans) {
    const bytes = files[pl.image];
    if (!bytes) continue;
    const type = /\.png$/i.test(pl.image) ? "image/png" : /\.webp$/i.test(pl.image) ? "image/webp" : "image/jpeg";
    await dbPut("planimgs", new Blob([bytes], { type }), `${m.project.id}:${pl.id}`);
  }
  const rec = { id: m.project.id, name: m.project.name, code: m.project.code || "", plans: m.plans, defects: m.defects, trades: m.trades || [], createdAt: m.createdAt, loadedAt: new Date().toISOString() };
  await dbPut("projects", rec);
  return rec;
}

/* ---------- Projekt ---------- */
async function viewProject(pid) {
  const p = await dbGet("projects", pid);
  if (!p) return go("#/");
  const caps = await capturesOf(pid);
  const open = caps.filter((c) => !c.handedOver);
  const handed = caps.filter((c) => c.handedOver);
  const diary = caps.filter((c) => c.type === "diary").sort((a, b) => b.date.localeCompare(a.date));
  const photoCount = (list) => list.reduce((n, c) => n + c.photos.length, 0);
  app.innerHTML = `
    ${header(p.name, "")}
    <main>
      <h2>Pläne</h2>
      ${p.plans.length ? `<div class="list">${p.plans.map((pl) => {
        const n = caps.filter((c) => c.type === "defect" && c.planId === pl.id).length;
        return `<button class="row" data-plan="${esc(pl.id)}"><span class="grow">${esc(pl.number)} ${esc(pl.name)}<small>Index ${esc(pl.revision || "–")}</small></span>${n ? `<span class="badge">${n}</span>` : ""}<span class="chev">›</span></button>`;
      }).join("")}</div>` : `<p class="empty">Dieses Paket enthält keine Pläne.</p>`}
      <h2>Bautagebuch</h2>
      <div class="list">
        <button class="row" data-diary="new"><span class="grow"><b>Neuer Eintrag</b></span><span class="chev">＋</span></button>
        ${diary.map((c) => `<button class="row" data-diary="${esc(c.id)}"><span class="grow">${esc(deDate(c.date))}<small>${esc(c.weatherText || "")}${c.activities ? ` · ${esc(c.activities.split("\n")[0])}` : ""}</small></span>${c.handedOver ? `<span class="badge muted">abgegeben</span>` : ""}<span class="chev">›</span></button>`).join("")}
      </div>
      <h2>Abgeben</h2>
      <div class="list"><div class="row"><span class="grow">${open.length ? `${open.filter((c) => c.type === "defect").length} Punkte, ${open.filter((c) => c.type === "diary").length} Bautagebuch-Einträge, ${photoCount(open)} Fotos warten auf die Abgabe` : "Nichts zum Abgeben"}</span></div></div>
      <button class="btn primary block" id="hand" ${open.length ? "" : "disabled"}>Erfassung abgeben</button>
      ${handed.length ? `<button class="btn block" id="again">Alles noch einmal abgeben (${caps.length})</button><button class="btn danger block" id="purge">Abgegebene vom Gerät entfernen (${handed.length})</button>` : ""}
      <button class="btn danger block" id="drop">Projekt vom Gerät entfernen</button>
      <p class="note">Abgegeben wird als Datei über das Teilen-Menü: AirDrop an den Mac oder in den Ordner „_Austausch/Eingang“ im Synology-Drive-Ordner von HEJ.</p>
    </main>`;
  bindBack();
  $$("[data-plan]").forEach((b) => b.addEventListener("click", () => go(`#/p/${pid}/plan/${b.dataset.plan}`)));
  $$("[data-diary]").forEach((b) => b.addEventListener("click", () => go(`#/p/${pid}/diary/${b.dataset.diary}`)));
  $("#hand").addEventListener("click", () => prepareHandOver(p, open));
  $("#again")?.addEventListener("click", () => prepareHandOver(p, caps));
  $("#purge")?.addEventListener("click", async () => {
    if (!confirm("Bereits abgegebene Erfassungen und ihre Fotos vom Gerät entfernen? Prüfe vorher, ob sie in HEJ angekommen sind.")) return;
    for (const c of handed) await removeCapture(c);
    route();
  });
  $("#drop").addEventListener("click", async () => {
    if (open.length && !confirm(`${open.length} Erfassungen wurden noch nicht abgegeben und gehen verloren. Trotzdem entfernen?`)) return;
    if (!open.length && !confirm("Das Projekt mit Plänen und allen Erfassungen vom Gerät entfernen?")) return;
    for (const c of caps) await removeCapture(c);
    for (const pl of p.plans) await dbDel("planimgs", `${p.id}:${pl.id}`);
    await dbDel("projects", p.id);
    go("#/");
  });
}

async function removeCapture(c) {
  for (const ph of c.photos) { await dbDel("photos", ph.id); thumbUrls.delete(ph.id); }
  await dbDel("captures", c.id);
}

/* ---------- Abgeben ---------- */
async function prepareHandOver(p, list) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `<div class="sheet"><h3>Abgabe wird vorbereitet …</h3></div>`;
  document.body.append(scrim);
  try {
    const files = {};
    const defects = [], diary = [];
    let photos = 0;
    const refs = async (c) => {
      const out = [];
      for (const ph of c.photos) {
        const rec = await dbGet("photos", ph.id);
        if (!rec) continue;
        const file = `photos/${ph.id}.jpg`;
        files[file] = new Uint8Array(await rec.blob.arrayBuffer());
        out.push({ file, takenAt: ph.takenAt });
        photos++;
      }
      return out;
    };
    for (const c of list) {
      if (c.type === "defect") defects.push({ id: c.id, planId: c.planId, x: c.x, y: c.y, kind: c.kind, title: c.title, description: c.description, trade: c.trade, priority: c.priority, createdAt: c.createdAt, photos: await refs(c) });
      else diary.push({ id: c.id, date: c.date, weatherText: c.weatherText, tempMin: c.tempMin, tempMax: c.tempMax, hindered: !!c.hindered, activities: c.activities, hindrances: c.hindrances, deliveries: c.deliveries, visitors: c.visitors, notes: c.notes, photos: await refs(c) });
    }
    const now = new Date();
    files["erfassung.json"] = fflate.strToU8(JSON.stringify({ format: "hej-erfassung", version: 1, id: uid(), createdAt: now.toISOString(), project: { id: p.id, name: p.name }, defects, diary }));
    const zip = fflate.zipSync(files, { level: 0 });
    const name = `HEJ-Erfassung_${slug(p.code || p.name)}_${yymmdd(now)}_${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
    const file = new File([zip], name, { type: "application/zip" });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const url = URL.createObjectURL(file);
    const markDone = async () => { for (const c of list) if (!c.handedOver) await dbPut("captures", { ...c, handedOver: new Date().toISOString() }); };
    scrim.innerHTML = `<div class="sheet"><h3>Abgabe bereit</h3><p>${defects.length} Punkte, ${diary.length} Bautagebuch-Einträge, ${photos} Fotos · ${(zip.length / 1048576).toFixed(1)} MB</p>
      ${canShare ? `<button class="btn primary block" id="share" style="width:100%;margin:.5rem 0">Teilen / Speichern …</button>` : ""}
      <a class="btn block" id="dl" style="width:100%;margin:.5rem 0;text-decoration:none" href="${url}" download="${esc(name)}">Als Datei laden</a>
      <p class="note" style="margin:.5rem 0">Wähle im Teilen-Menü AirDrop (Mac) oder „In Dateien sichern“ → Synology Drive → HEJ → _Austausch → Eingang.</p>
      <div class="actions"><button class="btn" id="close">Schließen</button></div></div>`;
    const finish = async () => { await markDone(); scrim.remove(); URL.revokeObjectURL(url); route(); };
    $("#close").addEventListener("click", () => { scrim.remove(); URL.revokeObjectURL(url); });
    $("#dl").addEventListener("click", () => { setTimeout(() => { if (confirm("Wurde die Datei gespeichert? Dann als abgegeben markieren.")) finish(); }, 800); });
    $("#share")?.addEventListener("click", async () => {
      try { await navigator.share({ files: [file], title: "HEJ Erfassung" }); await finish(); }
      catch (e) { if (e && e.name !== "AbortError") showError("Teilen war nicht möglich. Nutze „Als Datei laden“."); }
    });
  } catch (e) {
    scrim.remove();
    showError(`Die Abgabe konnte nicht vorbereitet werden: ${e.message || e}`);
  }
}

/* ---------- Plan mit Zoom und Punkten ---------- */
const KIND_COLOR = { mangel: "var(--k-mangel)", restleistung: "var(--k-restleistung)", klaerung: "var(--k-klaerung)", hinweis: "var(--k-hinweis)" };

async function viewPlan(pid, planId) {
  const p = await dbGet("projects", pid);
  const plan = p && p.plans.find((x) => x.id === planId);
  const blob = plan && (await dbGet("planimgs", `${pid}:${planId}`));
  if (!plan || !blob) { go(`#/p/${pid}`); return; }
  const imgUrl = URL.createObjectURL(blob);
  let caps = (await capturesOf(pid)).filter((c) => c.type === "defect" && c.planId === planId);
  app.innerHTML = `<div class="planpage">${header(`${plan.number} ${plan.name}`, `p/${pid}`)}<div class="viewer" id="viewer"><div class="stage" id="stage"><img id="img" alt="Plan" src="${imgUrl}"></div></div><div class="bar"><span id="count"></span><span>Auf den Plan tippen = neuer Punkt</span></div></div>`;
  bindBack();
  const viewer = $("#viewer"), stage = $("#stage"), img = $("#img");
  let s = 1, tx = 0, ty = 0, minS = 0.05;
  const apply = () => { stage.style.transform = `translate(${tx}px,${ty}px) scale(${s})`; stage.style.setProperty("--inv", String(1 / s)); };
  const fit = () => {
    const vw = viewer.clientWidth, vh = viewer.clientHeight, iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !vw) return;
    stage.style.width = `${iw}px`; stage.style.height = `${ih}px`; img.style.width = `${iw}px`; img.style.height = `${ih}px`;
    s = Math.min(vw / iw, vh / ih); minS = s * 0.9; tx = (vw - iw * s) / 2; ty = (vh - ih * s) / 2; apply();
  };
  const pinsHtml = () => {
    const old = p.defects.filter((d) => d.planId === planId).map((d) => `<div class="pin old" data-old="${esc(d.id)}" style="left:${d.x * 100}%;top:${d.y * 100}%;--pc:#888"><span>${d.number}</span></div>`);
    const mine = caps.map((c, i) => `<div class="pin${c.handedOver ? " done" : ""}" data-cap="${esc(c.id)}" style="left:${c.x * 100}%;top:${c.y * 100}%;--pc:${KIND_COLOR[c.kind]}"><span>${i + 1}</span></div>`);
    $$(".pin", stage).forEach((n) => n.remove());
    stage.insertAdjacentHTML("beforeend", [...old, ...mine].join(""));
    $("#count").textContent = `${caps.length} ${caps.length === 1 ? "neuer Punkt" : "neue Punkte"}`;
  };
  const reload = async () => { caps = (await capturesOf(pid)).filter((c) => c.type === "defect" && c.planId === planId); pinsHtml(); };
  if (img.complete && img.naturalWidth) fit(); else img.addEventListener("load", fit);
  pinsHtml();
  const onResize = () => fit();
  window.addEventListener("resize", onResize);
  cleanup = () => { window.removeEventListener("resize", onResize); URL.revokeObjectURL(imgUrl); };

  const zoomAt = (cx, cy, factor) => {
    const r = viewer.getBoundingClientRect();
    const ns = Math.min(40, Math.max(minS, s * factor));
    const k = ns / s, ax = cx - r.left, ay = cy - r.top;
    tx = ax - (ax - tx) * k; ty = ay - (ay - ty) * k; s = ns; apply();
  };
  viewer.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  const ptrs = new Map();
  let tap = null, last = null;
  viewer.addEventListener("pointerdown", (e) => {
    viewer.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) tap = { x: e.clientX, y: e.clientY, t: Date.now(), target: e.target };
    else tap = null;
    last = null;
  });
  viewer.addEventListener("pointermove", (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap = null;
    if (tap) return;
    if (ptrs.size === 1) { tx += e.clientX - prev.x; ty += e.clientY - prev.y; apply(); }
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (last) { zoomAt(mx, my, dist / last.dist); tx += mx - last.mx; ty += my - last.my; apply(); }
      last = { dist, mx, my };
    }
  });
  const end = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const wasTap = tap && ptrs.size === 1 && Date.now() - tap.t < 700 && e.type === "pointerup";
    const target = tap && tap.target;
    ptrs.delete(e.pointerId); last = null;
    if (ptrs.size === 0 && wasTap) {
      const pin = target && target.closest && target.closest(".pin");
      if (pin && pin.dataset.cap) { const c = caps.find((x) => x.id === pin.dataset.cap); if (c) openPointSheet(p, plan, c, reload); }
      else if (pin && pin.dataset.old) { const d = p.defects.find((x) => x.id === pin.dataset.old); if (d) infoToast(`#${d.number} ${KINDS[d.kind] || ""}: ${d.title}${d.trade ? ` · ${d.trade}` : ""} · ${d.status}`); }
      else {
        const r = stage.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) openPointSheet(p, plan, { id: uid(), type: "defect", projectId: pid, planId, x, y, kind: "mangel", title: "", description: "", trade: "", priority: "mittel", createdAt: new Date().toISOString(), photos: [] }, reload, true);
      }
    }
    if (ptrs.size === 0) tap = null;
  };
  viewer.addEventListener("pointerup", end);
  viewer.addEventListener("pointercancel", end);
}

function infoToast(text) {
  $$(".toast").forEach((t) => t.remove());
  const d = document.createElement("div"); d.className = "toast"; d.textContent = text; document.body.append(d); setTimeout(() => d.remove(), 4000);
}

/* ---------- Formular: Punkt ---------- */
function photoPicker(draft, rerender) {
  return `<div class="thumbs" id="thumbs"></div>
    <div class="two"><label class="btn">Foto aufnehmen<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
    <label class="btn">Aus Fotos<input id="lib" type="file" accept="image/*" multiple hidden></label></div>
    <p class="note" id="photomsg" style="margin:.4rem 0"></p>`;
}
async function renderThumbs(draft, root) {
  const box = $("#thumbs", root);
  box.innerHTML = "";
  for (const ph of draft.photos) {
    const url = await thumbUrl(ph.id);
    const d = document.createElement("div"); d.className = "thumb";
    d.innerHTML = `<img alt="" src="${url}"><button type="button" aria-label="Foto entfernen">×</button>`;
    d.querySelector("button").addEventListener("click", () => { draft.photos = draft.photos.filter((x) => x.id !== ph.id); draft.removed.push(ph.id); renderThumbs(draft, root); });
    box.append(d);
  }
}
function bindPhotoInputs(draft, root) {
  const handle = async (input) => {
    const files = [...input.files]; input.value = "";
    if (!files.length) return;
    $("#photomsg", root).textContent = "Foto wird verarbeitet …";
    const failed = await addPhotoFiles(files, draft);
    $("#photomsg", root).textContent = failed.length ? `Nicht lesbar: ${failed.join(", ")}` : "";
    renderThumbs(draft, root);
  };
  $("#cam", root).addEventListener("change", (e) => handle(e.target));
  $("#lib", root).addEventListener("change", (e) => handle(e.target));
}
/** Entfernt nach dem Speichern/Abbrechen die Fotos, die nicht (mehr) gebraucht werden. */
async function settlePhotos(draft, saved) {
  const drop = saved ? draft.removed : draft.added;
  for (const id of drop) { if (saved && draft.photos.some((x) => x.id === id)) continue; await dbDel("photos", id); thumbUrls.delete(id); }
}

function openPointSheet(p, plan, cap, done, isNew = false) {
  const draft = { photos: [...cap.photos], added: [], removed: [] };
  const st = { kind: cap.kind, priority: cap.priority };
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const seg = (name, opts, cur) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === cur ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
  scrim.innerHTML = `<form class="sheet">
    <h3>${isNew ? "Neuer Punkt" : "Punkt bearbeiten"}</h3>
    <label class="f">Art</label>${seg("kind", Object.entries(KINDS), st.kind)}
    <label class="f">Kurztext</label><input type="text" id="title" value="${esc(cap.title)}" placeholder="z. B. Estrich gerissen" autocomplete="off">
    <label class="f">Gewerk</label><input type="text" id="trade" value="${esc(cap.trade)}" list="trades" placeholder="z. B. Trockenbau" autocomplete="off"><datalist id="trades">${p.trades.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    <label class="f">Priorität</label>${seg("priority", PRIOS.map((x) => [x, x]), st.priority)}
    <label class="f">Beschreibung</label><textarea id="desc">${esc(cap.description)}</textarea>
    <label class="f">Fotos</label>${photoPicker(draft)}
    <div class="actions">${isNew ? "" : `<button type="button" class="btn danger" id="del">Löschen</button>`}<button type="button" class="btn" id="cancel">Abbrechen</button><button type="submit" class="btn primary">Speichern</button></div>
  </form>`;
  document.body.append(scrim);
  const root = scrim;
  $$("[data-seg]", root).forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    st[g.dataset.seg] = b.dataset.v; $$("button", g).forEach((x) => x.classList.toggle("on", x === b));
  }));
  bindPhotoInputs(draft, root);
  renderThumbs(draft, root);
  const close = () => scrim.remove();
  $("#cancel", root).addEventListener("click", async () => { await settlePhotos(draft, false); close(); });
  $("#del", root)?.addEventListener("click", async () => { if (!confirm("Diesen Punkt samt Fotos löschen?")) return; await removeCapture(cap); close(); done(); });
  $("form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const rec = { ...cap, kind: st.kind, priority: st.priority, title: $("#title", root).value.trim(), trade: $("#trade", root).value.trim(), description: $("#desc", root).value.trim(), photos: draft.photos };
    if (!rec.title) rec.title = KINDS[rec.kind];
    delete rec.handedOver;
    await dbPut("captures", rec);
    await settlePhotos(draft, true);
    close(); done();
  });
}

/* ---------- Bautagebuch ---------- */
async function viewDiary(pid, id) {
  const p = await dbGet("projects", pid);
  if (!p) return go("#/");
  const isNew = !id || id === "new";
  const cap = isNew ? { id: uid(), type: "diary", projectId: pid, date: today(), weatherText: "", hindered: false, activities: "", hindrances: "", deliveries: "", visitors: "", notes: "", photos: [], createdAt: localIso(new Date()) } : await dbGet("captures", id);
  if (!cap) return go(`#/p/${pid}`);
  const draft = { photos: [...cap.photos], added: [], removed: [] };
  const ta = (key, label, rows = 3) => `<label class="f">${label}</label><textarea id="${key}" rows="${rows}">${esc(cap[key])}</textarea>`;
  app.innerHTML = `${header("Bautagebuch", `p/${pid}`)}<main><form id="df" style="padding:0 1rem">
    <label class="f">Datum</label><input type="date" id="date" value="${esc(cap.date)}" required>
    <label class="f">Wetter</label><select id="weather">${WEATHER.map((w) => `<option value="${esc(w)}" ${w === cap.weatherText ? "selected" : ""}>${esc(w || "–")}</option>`).join("")}</select>
    <div class="two"><div><label class="f">Temperatur min. °C</label><input type="number" id="tmin" inputmode="decimal" step="any" value="${cap.tempMin ?? ""}"></div><div><label class="f">Temperatur max. °C</label><input type="number" id="tmax" inputmode="decimal" step="any" value="${cap.tempMax ?? ""}"></div></div>
    <label class="check"><input type="checkbox" id="hind" ${cap.hindered ? "checked" : ""}> Witterung behindert die Arbeiten</label>
    ${ta("activities", "Ausgeführte Arbeiten (eine pro Zeile)", 5)}${ta("hindrances", "Behinderungen / Bedenken")}${ta("deliveries", "Lieferungen")}${ta("visitors", "Besucher / Besprechungen")}${ta("notes", "Sonstiges")}
    <label class="f">Fotos</label>${photoPicker(draft)}
    <div class="actions">${isNew ? "" : `<button type="button" class="btn danger" id="del">Löschen</button>`}<button type="submit" class="btn primary">Speichern</button></div>
  </form></main>`;
  bindBack();
  bindPhotoInputs(draft, document);
  renderThumbs(draft, document);
  cleanup = () => { settlePhotos(draft, false); };
  $("#del")?.addEventListener("click", async () => { if (!confirm("Diesen Eintrag samt Fotos löschen?")) return; cleanup = null; await removeCapture(cap); go(`#/p/${pid}`); });
  $("#df").addEventListener("submit", async (e) => {
    e.preventDefault();
    const num = (k) => { const v = $(k).value.trim().replace(",", "."); return v === "" || isNaN(Number(v)) ? undefined : Number(v); };
    const rec = { ...cap, date: $("#date").value || today(), weatherText: $("#weather").value, tempMin: num("#tmin"), tempMax: num("#tmax"), hindered: $("#hind").checked,
      activities: $("#activities").value.trim(), hindrances: $("#hindrances").value.trim(), deliveries: $("#deliveries").value.trim(), visitors: $("#visitors").value.trim(), notes: $("#notes").value.trim(), photos: draft.photos };
    delete rec.handedOver;
    await dbPut("captures", rec);
    await settlePhotos(draft, true);
    cleanup = null;
    go(`#/p/${pid}`);
  });
}

/* ---------- Start ---------- */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
route();
