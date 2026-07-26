(() => {
  const statusEl = document.getElementById("status");
  const cfg = window.APP_CONFIG || {};

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || cfg.supabaseUrl.includes("YOUR_")) {
    setStatus("חסר config.js — מלאו supabaseUrl ו-supabaseAnonKey", "err");
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  let apartments = [];
  let verdicts = {};
  let noteTimers = {};

  function ensureVerdict(id) {
    if (!verdicts[id]) verdicts[id] = { relevant: true, note: "" };
    return verdicts[id];
  }

  function fmtPrice(p) {
    if (p == null) return "—";
    return Number(p).toLocaleString("en-US") + " ₪";
  }

  function fmtArea(a) {
    const b = a.built == null ? "—" : String(a.built);
    const g = a.garden == null || a.garden === "" ? "—" : String(a.garden);
    return b + " / " + g;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function thumbSrc(a) {
    if (!a.thumb) return null;
    return a.thumb;
  }

  function renderTable(list, mode) {
    if (!list.length) return '<div class="empty-state">אין דירות בקבוצה הזו</div>';
    const rows = list
      .map((a, i) => {
        const st = ensureVerdict(a.id);
        const src = thumbSrc(a);
        const thumb = src
          ? `<img src="${escapeHtml(src)}" alt="">`
          : `<div class="empty">אין</div>`;
        const badges = [
          a.visited ? '<span class="badge visit">ביקור</span>' : "",
          a.expired ? '<span class="badge expired">לא זמין</span>' : "",
        ].join("");
        const link = a.url
          ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">מודעה</a>`
          : "—";
        const action =
          mode === "relevant"
            ? `<button type="button" class="btn drop" data-action="drop" data-id="${escapeHtml(a.id)}">לא רלוונטי</button>`
            : `<button type="button" class="btn keep" data-action="keep" data-id="${escapeHtml(a.id)}">רלוונטי</button>`;
        return `<tr>
          <td class="num">${i + 1}</td>
          <td class="thumb">${thumb}</td>
          <td>
            <div class="name">${escapeHtml(a.name)}${badges}</div>
            <div class="meta">${escapeHtml(a.neighborhood || "")}</div>
          </td>
          <td class="price">${fmtPrice(a.price)}</td>
          <td>${a.rooms == null ? "—" : escapeHtml(a.rooms)}</td>
          <td>${escapeHtml(fmtArea(a))}</td>
          <td>${link}</td>
          <td class="verdict">
            <input type="text" maxlength="120" placeholder="למה? בקצרה..."
              data-note="${escapeHtml(a.id)}" value="${escapeHtml(st.note)}">
          </td>
          <td class="actions">${action}</td>
        </tr>`;
      })
      .join("");
    return `<table>
      <thead>
        <tr>
          <th>#</th><th>תמונה</th><th>דירה</th><th>מחיר</th><th>חדרים</th>
          <th>שטח</th><th>קישור</th><th>הסבר</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function lastModifiedMs(a) {
    const v = ensureVerdict(a.id);
    const aptMs = a.updated_at ? Date.parse(a.updated_at) : 0;
    const verdMs = v.updated_at ? Date.parse(v.updated_at) : 0;
    const createdMs = a.created_at ? Date.parse(a.created_at) : 0;
    return Math.max(aptMs, verdMs, createdMs) || 0;
  }

  function render() {
    const sorted = [...apartments].sort((a, b) => lastModifiedMs(b) - lastModifiedMs(a));
    const relevant = sorted.filter((a) => ensureVerdict(a.id).relevant);
    const dropped = sorted.filter((a) => !ensureVerdict(a.id).relevant);
    document.getElementById("relevantWrap").innerHTML = renderTable(relevant, "relevant");
    document.getElementById("droppedWrap").innerHTML = renderTable(dropped, "dropped");
    document.getElementById("countRelevant").textContent = `(${relevant.length})`;
    document.getElementById("countDropped").textContent = `(${dropped.length})`;
  }

  async function setRelevant(id, relevant) {
    const updated_at = new Date().toISOString();
    ensureVerdict(id).relevant = relevant;
    ensureVerdict(id).updated_at = updated_at;
    render();
    const { error } = await sb.from("verdicts").upsert({
      apartment_id: id,
      relevant,
      note: ensureVerdict(id).note,
      updated_at,
    });
    if (error) setStatus("שגיאה בשמירה: " + error.message, "err");
  }

  async function saveNote(id, note) {
    const updated_at = new Date().toISOString();
    ensureVerdict(id).note = note;
    ensureVerdict(id).updated_at = updated_at;
    render();
    const { error } = await sb.from("verdicts").upsert({
      apartment_id: id,
      relevant: ensureVerdict(id).relevant,
      note,
      updated_at,
    });
    if (error) setStatus("שגיאה בשמירת הערה: " + error.message, "err");
  }

  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    setRelevant(btn.getAttribute("data-id"), btn.getAttribute("data-action") === "keep");
  });

  document.body.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-note]");
    if (!input) return;
    const id = input.getAttribute("data-note");
    ensureVerdict(id).note = input.value;
    clearTimeout(noteTimers[id]);
    noteTimers[id] = setTimeout(() => saveNote(id, input.value), 400);
  });

  function applyApartmentRows(rows) {
    apartments = (rows || [])
      .filter((r) => !!r.thumb)
      .map((r) => ({
        id: r.id,
        name: r.name,
        neighborhood: r.neighborhood || "",
        price: r.price,
        rooms: r.rooms,
        built: r.built,
        garden: r.garden,
        url: r.url,
        visited: !!r.visited,
        expired: !!r.expired,
        thumb: r.thumb,
        chat_notes: r.chat_notes || "",
        created_at: r.created_at || null,
        updated_at: r.updated_at || r.created_at || null,
      }));
  }

  function applyVerdictRows(rows) {
    verdicts = {};
    for (const r of rows || []) {
      verdicts[r.apartment_id] = {
        relevant: r.relevant !== false,
        note: r.note || "",
        updated_at: r.updated_at || null,
      };
    }
  }

  async function loadAll() {
    const [aRes, vRes] = await Promise.all([
      sb.from("apartments").select("*").order("created_at", { ascending: true }),
      sb.from("verdicts").select("*"),
    ]);
    if (aRes.error) throw aRes.error;
    if (vRes.error) throw vRes.error;
    applyApartmentRows(aRes.data);
    applyVerdictRows(vRes.data);
    for (const a of apartments) ensureVerdict(a.id);
    render();
  }

  function subscribe() {
    sb.channel("live-apartments")
      .on("postgres_changes", { event: "*", schema: "public", table: "apartments" }, async () => {
        const { data, error } = await sb.from("apartments").select("*");
        if (!error) {
          applyApartmentRows(data);
          for (const a of apartments) ensureVerdict(a.id);
          render();
          setStatus("עודכן דירות · " + new Date().toLocaleTimeString("he-IL"), "ok");
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "verdicts" }, async () => {
        const { data, error } = await sb.from("verdicts").select("*");
        if (!error) {
          applyVerdictRows(data);
          for (const a of apartments) ensureVerdict(a.id);
          render();
        }
      })
      .subscribe((s) => {
        if (s === "SUBSCRIBED") setStatus("מחובר בלייב", "ok");
      });
  }

  loadAll()
    .then(() => {
      setStatus("מחובר · " + apartments.length + " דירות", "ok");
      subscribe();
    })
    .catch((err) => {
      console.error(err);
      setStatus("שגיאת חיבור: " + (err.message || err), "err");
    });
})();
