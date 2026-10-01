(function () {
  "use strict";
  var CFG = window.CONFIG;
  var sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
  var ME = null;           // { id, nome, papel, empresa_id }
  var loaded = {};
  var PAGE = 50;

  /* ---------------- utilidades ---------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function pane(n) { return document.querySelector('[data-pane="' + n + '"]'); }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }
  function fmtDate(s) { if (!s) return "—"; var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + "/" + m[2] + "/" + m[1] : s; }
  function fmtNum(n) { if (n == null || n === "") return "—"; return Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 3 }); }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }
  function canWrite() { return !!ME && (ME.papel === "admin" || ME.papel === "operador"); }
  function nowIso() { return new Date().toISOString(); }
  var STATUS = { aguardando_preenchimento: "Aguardando preenchimento", pendente_aprovacao: "Pendente de aprovação", aprovado: "Aprovado", rejeitado: "Rejeitado", cancelado: "Cancelado" };

  var toastTimer;
  function toast(msg, bad) {
    var t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.className = "toast" + (bad ? " bad" : ""); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 5000 : 1800);
  }

  /* ---------------- acesso ao banco ---------------- */
  function friendly(err) {
    var m = (err && err.message) || "", c = err && (err.code || err.status);
    if (/failed to fetch|networkerror|load failed/i.test(m)) return "Sem conexão com a internet ou com o banco de dados.";
    if (c === "PGRST301" || /jwt/i.test(m)) return "Sua sessão expirou. Saia e entre de novo.";
    if (c === "42501" || c === 401 || c === 403) return "Você não tem permissão para esta ação.";
    if (c === "23505") return "Esse registro já existe.";
    if (c === 429) return "Muitas tentativas. Aguarde um minuto.";
    return m || "Erro desconhecido.";
  }
  async function Q(promise) {
    var r;
    try { r = await promise; } catch (e) { var x = new Error(friendly(e)); x.code = "net"; throw x; }
    if (r.error) { var e2 = new Error(friendly(r.error)); e2.code = r.error.code; if (/jwt|PGRST301/i.test((r.error.message || "") + (r.error.code || ""))) e2.sessao = true; throw e2; }
    return r;
  }
  function errBox(e, retryPane) {
    if (e && e.sessao) { setTimeout(function () { sb.auth.signOut(); }, 0); }
    return '<div class="state err" role="alert"><strong>Não foi possível carregar</strong>' + esc(e.message) + (retryPane ? '<br><button class="btn ghost" data-retry="' + retryPane + '">Tentar de novo</button>' : "") + "</div>";
  }

  /* ---------------- login / sessão ---------------- */
  function show(id) { ["boot", "login", "app"].forEach(function (x) { $("#" + x).hidden = x !== id; }); }
  function toEmail(u) {
    u = String(u || "").trim().toLowerCase();
    if (u.indexOf("@") >= 0) return u;
    u = u.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9._-]/g, "");
    return u + "@" + CFG.dominioLogin;
  }
  $("#loginForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var go = $("#loginGo"), msg = $("#loginMsg");
    var u = $("#lu").value, p = $("#lp").value;
    if (!u.trim() || !p) { msg.className = "msg bad"; msg.textContent = "Informe usuário e senha."; return; }
    go.disabled = true; msg.className = "msg"; msg.textContent = "Entrando…";
    var r;
    try { r = await sb.auth.signInWithPassword({ email: toEmail(u), password: p }); }
    catch (e) { r = { error: { message: "Failed to fetch" } }; }
    go.disabled = false;
    if (r.error) {
      msg.className = "msg bad";
      msg.textContent = /invalid login/i.test(r.error.message) ? "Usuário ou senha incorretos." : friendly(r.error);
      return;
    }
    $("#lp").value = ""; msg.textContent = "";
    await enter(r.data.user);
  });

  async function enter(user) {
    try {
      var r = await Q(sb.from("membros").select("empresa_id,papel,nome").eq("user_id", user.id).maybeSingle());
      if (!r.data) {
        await sb.auth.signOut(); show("login");
        var m = $("#loginMsg"); m.className = "msg bad"; m.textContent = "Este usuário não tem acesso a nenhuma empresa. Fale com o administrador.";
        return;
      }
      ME = { id: user.id, nome: r.data.nome || user.email, papel: r.data.papel, empresa_id: r.data.empresa_id };
    } catch (e) {
      show("login"); var mm = $("#loginMsg"); mm.className = "msg bad"; mm.textContent = e.message; return;
    }
    var papelTxt = { admin: "administrador", operador: "operador", leitura: "somente leitura" }[ME.papel] || ME.papel;
    $("#whoTxt").textContent = ME.nome + " · " + papelTxt;
    loaded = {};
    show("app");
    showTab("resumo");
  }
  $("#btnSair").addEventListener("click", function () { sb.auth.signOut(); });
  $("#btnConta").addEventListener("click", function () { showTab("conta"); });
  sb.auth.onAuthStateChange(function (ev) {
    if (ev === "SIGNED_OUT") { ME = null; loaded = {}; show("login"); }
  });

  /* ---------------- abas ---------------- */
  var LOADERS = {};
  function showTab(name) {
    document.querySelectorAll("#tabs button").forEach(function (b) { b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false"); });
    document.querySelectorAll("[data-pane]").forEach(function (p) { p.hidden = p.dataset.pane !== name; });
    try { history.replaceState(null, "", "#" + name); } catch (e) { }
    if (!loaded[name]) { loaded[name] = true; LOADERS[name](); }
  }
  $("#tabs").addEventListener("click", function (ev) { var b = ev.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
  document.addEventListener("click", function (ev) {
    var r = ev.target.closest("[data-retry]");
    if (r) { loaded[r.dataset.retry] = true; LOADERS[r.dataset.retry](); }
  });
  function head(title, sub) { return "<h2>" + title + '</h2><p class="sub">' + sub + "</p>"; }
  function armConfirm(btn, run) {
    if (btn.dataset.armed) { run(); return; }
    btn.dataset.armed = "1"; var old = btn.textContent; btn.textContent = "Confirmar"; btn.classList.add("confirm");
    setTimeout(function () { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; btn.classList.remove("confirm"); } }, 3500);
  }
  function setBadge(n) { var b = $("#badgeAprov"); b.hidden = !(n > 0); b.textContent = n; }

  /* ---------------- Resumo ---------------- */
  LOADERS.resumo = async function () {
    var el = pane("resumo");
    el.innerHTML = head("Resumo", "O que existe hoje no banco de dados.") + '<div class="state">Carregando…</div>';
    var tabs = [["usinas", "Usinas"], ["fornecedores", "Fornecedores"], ["fabricas", "Fábricas"], ["frota", "Frota VPO"], ["programacao_dias", "Dias de programação"], ["programacao_cargas", "Cargas programadas"], ["notas_sefaz", "Notas SEFAZ"], ["lancamentos_puzl", "Lançamentos PUZL"]];
    try {
      var t0 = performance.now();
      var res = await Promise.all(tabs.map(function (t) { return Q(sb.from(t[0]).select("id", { count: "exact", head: true }).is("deleted_at", null)); }));
      var pend = await Q(sb.from("solicitacoes_material").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("status", "pendente_aprovacao"));
      var ms = Math.round(performance.now() - t0), h = "";
      tabs.forEach(function (t, i) { h += "<div><span>" + t[1] + "</span><b>" + fmtNum(res[i].count) + "</b></div>"; });
      h += "<div><span>Aguardando aprovação</span><b>" + fmtNum(pend.count) + "</b></div>";
      el.innerHTML = head("Resumo", "O que existe hoje no banco de dados.") + '<div class="stat">' + h + '</div><p class="note">Consulta em <span class="timing">' + ms + " ms</span>.</p>";
      setBadge(pend.count || 0);
    } catch (e) { el.innerHTML = head("Resumo", "") + errBox(e, "resumo"); }
  };

  /* ---------------- Programação de Cimento ---------------- */
  var progDia = null, progUsinas = null;
  LOADERS.prog = async function () {
    var el = pane("prog");
    el.innerHTML = head("Programação de Cimento", "Dias, usinas e cargas. As alterações são salvas na hora e ficam no histórico.") + '<div class="state">Carregando…</div>';
    try {
      var r = await Q(sb.from("programacao_dias").select("id,data,referencia,excecao").is("deleted_at", null).order("data", { ascending: false }).limit(60));
      var fab = await sb.rpc("filtro_fabricas_programacao");
      var dias = r.data;
      var h = head("Programação de Cimento", "Dias, usinas e cargas. As alterações são salvas na hora e ficam no histórico.");
      if (canWrite()) h += '<div class="addrow"><div class="field"><label for="novoDia">Novo dia</label><input type="date" id="novoDia"></div><button class="btn" id="btnNovoDia" type="button">Criar dia</button></div>';
      if (!dias.length) h += '<div class="state"><strong>Nenhum dia programado</strong>Crie um dia para começar.</div>';
      h += '<div class="chips" id="dias">';
      dias.forEach(function (d) { h += '<button class="chip" type="button" data-dia="' + esc(d.id) + '" aria-pressed="false">' + fmtDate(d.data) + (d.excecao ? "<small>exceção</small>" : "") + "</button>"; });
      h += '</div><div id="diaBody"></div><datalist id="dlFab">';
      (fab.data || []).forEach(function (f) { h += '<option value="' + esc(f) + '">'; });
      h += "</datalist>";
      el.innerHTML = h;
      el.onclick = progClick; el.onchange = progChange;
      var alvo = dias.some(function (d) { return d.id === progDia; }) ? progDia : (dias[0] && dias[0].id);
      if (alvo) selectDia(alvo);
    } catch (e) { el.innerHTML = head("Programação de Cimento", "") + errBox(e, "prog"); }
  };
  function selectDia(id) {
    progDia = id;
    document.querySelectorAll("#dias .chip").forEach(function (c) { c.setAttribute("aria-pressed", c.dataset.dia === id ? "true" : "false"); });
    loadDia(id);
  }
  async function loadDia(id) {
    var box = $("#diaBody"); if (!box) return;
    var y = window.scrollY;
    try {
      var t0 = performance.now();
      var r = await Q(sb.from("programacao_itens")
        .select("id,usina_id,usina_nome,ordem,obs,programacao_cargas(id,ordem,placa,fabrica_nome,pedido)")
        .eq("dia_id", id).is("deleted_at", null).is("programacao_cargas.deleted_at", null)
        .order("ordem").order("ordem", { referencedTable: "programacao_cargas" }));
      if (progDia !== id) return;
      var ms = Math.round(performance.now() - t0), rows = r.data, w = canWrite(), nC = 0, h = "";
      var emUso = {};
      rows.forEach(function (it, i) {
        var cg = it.programacao_cargas || []; nC += cg.length; if (it.usina_id) emUso[it.usina_id] = 1;
        var maxo = cg.reduce(function (m, c) { return Math.max(m, c.ordem || 0); }, 0);
        h += '<div class="item" data-item="' + esc(it.id) + '" data-maxo="' + maxo + '"><header><span class="n">' + String(i + 1).padStart(2, "0") + "</span><strong>" + esc(it.usina_nome) + '</strong><span class="sp">';
        if (w) h += '<input class="cell" style="width:190px" data-item-obs="' + esc(it.id) + '" value="' + esc(it.obs || "") + '" placeholder="Observação" aria-label="Observação"><button class="btn small ghost" type="button" data-addcarga="' + esc(it.id) + '">+ Carga</button><button class="x" type="button" data-delitem="' + esc(it.id) + '" title="Remover usina do dia" aria-label="Remover usina">×</button>';
        else if (it.obs) h += '<span class="obs">' + esc(it.obs) + "</span>";
        h += '</span></header><div class="tablebox" style="border:0;border-radius:0"><table><thead><tr><th>Placa</th><th>Fábrica / material</th><th>Pedido</th>' + (w ? "<th></th>" : "") + "</tr></thead><tbody>";
        if (!cg.length) h += '<tr><td colspan="4" class="muted">Sem cargas lançadas.</td></tr>';
        cg.forEach(function (c) {
          if (w) h += '<tr><td><input class="cell mono" style="min-width:100px" data-carga="' + esc(c.id) + '" data-f="placa" value="' + esc(c.placa || "") + '" aria-label="Placa"></td><td><input class="cell" style="min-width:200px" list="dlFab" data-carga="' + esc(c.id) + '" data-f="fabrica_nome" value="' + esc(c.fabrica_nome || "") + '" aria-label="Fábrica"></td><td><input class="cell mono" style="min-width:110px" data-carga="' + esc(c.id) + '" data-f="pedido" value="' + esc(c.pedido || "") + '" aria-label="Pedido"></td><td class="act"><button class="x" type="button" data-delcarga="' + esc(c.id) + '" title="Remover carga" aria-label="Remover carga">×</button></td></tr>';
          else h += '<tr><td class="mono nowrap">' + esc(c.placa || "—") + "</td><td>" + esc(c.fabrica_nome || "—") + '</td><td class="mono">' + esc(c.pedido || "—") + "</td></tr>";
        });
        h += "</tbody></table></div></div>";
      });
      if (!rows.length) h = '<div class="state"><strong>Dia sem usinas</strong>' + (w ? "Adicione uma usina abaixo." : "") + "</div>";
      if (w) {
        if (!progUsinas) progUsinas = (await Q(sb.from("usinas").select("id,usina").is("deleted_at", null).order("usina"))).data;
        h += '<div class="addrow"><div class="field"><label for="addUsina">Adicionar usina neste dia</label><select id="addUsina"><option value="">Selecione…</option>';
        progUsinas.forEach(function (u) { if (!emUso[u.id]) h += '<option value="' + esc(u.id) + '">' + esc(u.usina) + "</option>"; });
        h += '</select></div><button class="btn" type="button" id="btnAddUsina">Adicionar</button></div>';
      }
      box.innerHTML = '<p class="note" style="margin:0 0 10px">' + rows.length + " usina(s) · " + nC + ' carga(s) · <span class="timing">' + ms + " ms</span></p>" + h;
      window.scrollTo(0, y);
    } catch (e) { box.innerHTML = errBox(e, "prog"); }
  }
  async function progChange(ev) {
    var i = ev.target;
    if (i.dataset.carga && i.dataset.f) {
      var v = i.value.trim();
      if (i.dataset.f === "placa") { v = v.toUpperCase().replace(/[^A-Z0-9]/g, ""); i.value = v; }
      try { await Q(sb.from("programacao_cargas").update((function (o) { o[i.dataset.f] = v || null; return o; })({})).eq("id", i.dataset.carga)); toast("Salvo"); }
      catch (e) { toast(e.message, true); }
    } else if (i.dataset.itemObs) {
      try { await Q(sb.from("programacao_itens").update({ obs: i.value.trim() || null }).eq("id", i.dataset.itemObs)); toast("Salvo"); }
      catch (e) { toast(e.message, true); }
    }
  }
  async function progClick(ev) {
    var t = ev.target.closest("button"); if (!t) return;
    try {
      if (t.dataset.dia) { selectDia(t.dataset.dia); return; }
      if (t.id === "btnNovoDia") {
        var d = $("#novoDia").value; if (!isDate(d)) { toast("Escolha a data.", true); return; }
        var r = await sb.from("programacao_dias").insert({ empresa_id: ME.empresa_id, data: d }).select("id").single();
        if (r.error) { toast(r.error.code === "23505" ? "Esse dia já existe." : friendly(r.error), true); return; }
        progDia = r.data.id; loaded.prog = true; await LOADERS.prog(); toast("Dia criado"); return;
      }
      if (t.id === "btnAddUsina") {
        var s = $("#addUsina"), uid = s.value; if (!isUuid(uid)) { toast("Escolha a usina.", true); return; }
        var n = document.querySelectorAll("#diaBody .item").length + 1;
        await Q(sb.from("programacao_itens").insert({ empresa_id: ME.empresa_id, dia_id: progDia, usina_id: uid, usina_nome: s.options[s.selectedIndex].textContent, ordem: n }));
        await loadDia(progDia); toast("Usina adicionada"); return;
      }
      if (t.dataset.addcarga) {
        var box = t.closest(".item"), prox = Number(box.dataset.maxo || 0) + 1;
        await Q(sb.from("programacao_cargas").insert({ empresa_id: ME.empresa_id, item_id: t.dataset.addcarga, ordem: prox }));
        await loadDia(progDia);
        var ins = document.querySelectorAll('.item[data-item="' + t.dataset.addcarga + '"] input[data-f="placa"]'); if (ins.length) ins[ins.length - 1].focus();
        return;
      }
      if (t.dataset.delcarga) { armConfirm(t, async function () { await Q(sb.from("programacao_cargas").update({ deleted_at: nowIso() }).eq("id", t.dataset.delcarga)); await loadDia(progDia); toast("Carga removida"); }); return; }
      if (t.dataset.delitem) {
        armConfirm(t, async function () {
          await Q(sb.from("programacao_cargas").update({ deleted_at: nowIso() }).eq("item_id", t.dataset.delitem).is("deleted_at", null));
          await Q(sb.from("programacao_itens").update({ deleted_at: nowIso() }).eq("id", t.dataset.delitem));
          await loadDia(progDia); toast("Usina removida do dia");
        });
      }
    } catch (e) { toast(e.message, true); }
  }

  /* ---------------- listas paginadas (Notas / PUZL) ---------------- */
  function makeList(cfg) {
    var st = { off: 0, tok: 0 };
    function fv(id) { var x = $("#" + cfg.pane + "_" + id); return x ? x.value.trim() : ""; }
    async function fetchPage() {
      var tok = ++st.tok, body = $("#" + cfg.pane + "_body");
      body.innerHTML = '<div class="state">Carregando…</div>';
      var t0 = performance.now();
      try {
        var qb = sb.from(cfg.table).select(cfg.cols, { count: "exact" }).is("deleted_at", null);
        var q = fv("q").replace(/[%*"\\(),]/g, " ").replace(/\s+/g, " ").trim();
        if (q) qb = qb.or(cfg.search.map(function (c) { return c + ".ilike.*" + q + "*"; }).join(","));
        var d1 = fv("d1"), d2 = fv("d2"), s = fv("sel");
        if (isDate(d1)) qb = qb.gte(cfg.date, d1);
        if (isDate(d2)) qb = qb.lte(cfg.date, d2);
        if (s) qb = qb.eq(cfg.selCol, s);
        cfg.order.forEach(function (o) { qb = qb.order(o, { ascending: o !== cfg.date, nullsFirst: false }); });
        var r = await Q(qb.range(st.off, st.off + PAGE - 1));
        if (tok !== st.tok) return;
        var ms = Math.round(performance.now() - t0), rows = r.data, total = r.count || 0;
        if (!rows.length) { body.innerHTML = '<div class="state"><strong>Nenhum registro encontrado</strong>Ajuste os filtros.</div>'; return; }
        var h = '<div class="tablebox"><table><thead><tr>' + cfg.heads.map(function (x) { return "<th" + (x[1] ? ' class="num"' : "") + ">" + x[0] + "</th>"; }).join("") + "</tr></thead><tbody>";
        rows.forEach(function (row) { h += "<tr>" + cfg.render(row) + "</tr>"; });
        var a = st.off + 1, b = st.off + rows.length;
        h += '</tbody></table></div><div class="pager"><span>' + fmtNum(a) + "–" + fmtNum(b) + " de " + fmtNum(total) + ' · <span class="timing">' + ms + ' ms</span></span><span class="btns"><button class="btn ghost" type="button" data-pg="-1"' + (st.off === 0 ? " disabled" : "") + '>Anterior</button><button class="btn ghost" type="button" data-pg="1"' + (b >= total ? " disabled" : "") + ">Próxima</button></span></div>";
        body.innerHTML = h;
      } catch (e) { if (tok === st.tok) body.innerHTML = errBox(e, cfg.pane); }
    }
    function reset() { st.off = 0; fetchPage(); }
    return async function load() {
      var el = pane(cfg.pane), p = cfg.pane;
      el.innerHTML = head(cfg.title, cfg.sub) +
        '<div class="row"><div class="field" style="flex:1 1 240px"><label for="' + p + '_q">Buscar</label><input type="search" id="' + p + '_q" placeholder="' + esc(cfg.ph) + '"></div>' +
        '<div class="field"><label for="' + p + '_d1">' + cfg.dateLabel + ' de</label><input type="date" id="' + p + '_d1"></div>' +
        '<div class="field"><label for="' + p + '_d2">até</label><input type="date" id="' + p + '_d2"></div>' +
        '<div class="field"><label for="' + p + '_sel">' + cfg.selLabel + '</label><select id="' + p + '_sel"><option value="">Todos</option></select></div></div><div id="' + p + '_body"></div>';
      var deb = debounce(reset, 350);
      $("#" + p + "_q").addEventListener("input", deb);
      ["d1", "d2", "sel"].forEach(function (i) { $("#" + p + "_" + i).addEventListener("change", reset); });
      el.onclick = function (ev) { var b = ev.target.closest("[data-pg]"); if (!b) return; st.off = Math.max(0, st.off + Number(b.dataset.pg) * PAGE); fetchPage(); };
      sb.rpc(cfg.rpc).then(function (r) {
        var s = $("#" + p + "_sel"); if (!s || r.error) return;
        (r.data || []).forEach(function (v) { var o = document.createElement("option"); o.value = v; o.textContent = v; s.appendChild(o); });
      });
      fetchPage();
    };
  }
  LOADERS.notas = makeList({
    pane: "notas", table: "notas_sefaz", title: "Notas SEFAZ", sub: "Busca, período e fornecedor são filtrados no banco; só 50 linhas por vez são carregadas.",
    ph: "Nº, material, pedido, placa, usina, motorista…", search: ["numero", "fornecedor", "material", "pedido", "placa", "usina", "motorista"],
    date: "emissao", dateLabel: "Emissão", selCol: "fornecedor", selLabel: "Fornecedor", rpc: "filtro_fornecedores_notas", order: ["emissao", "numero"],
    cols: "id,numero,emissao,fornecedor,material,pedido,placa,usina,motorista",
    heads: [["Nº"], ["Emissão"], ["Fornecedor"], ["Material"], ["Pedido"], ["Placa"], ["Usina"], ["Motorista"]],
    render: function (r) { return '<td class="mono">' + esc(r.numero) + '</td><td class="mono nowrap">' + fmtDate(r.emissao) + "</td><td>" + esc(r.fornecedor) + "</td><td>" + esc(r.material) + '</td><td class="mono">' + esc(r.pedido || "—") + '</td><td class="mono nowrap">' + esc(r.placa || "—") + "</td><td>" + esc(r.usina || "—") + "</td><td>" + esc(r.motorista || "—") + "</td>"; }
  });
  LOADERS.puzl = makeList({
    pane: "puzl", table: "lancamentos_puzl", title: "Lançamentos PUZL", sub: "Entradas do PUZL, filtradas e paginadas no banco.",
    ph: "Documento, item, fornecedor, central…", search: ["documento", "item", "fornecedor", "central_entrada", "categoria"],
    date: "data_entrada", dateLabel: "Entrada", selCol: "central_entrada", selLabel: "Central", rpc: "filtro_centrais_puzl", order: ["data_entrada", "documento"],
    cols: "id,central_entrada,data_entrada,fornecedor,item,documento,serie,emissao_nf,un_compra,quantidade",
    heads: [["Entrada"], ["Central"], ["Fornecedor"], ["Item"], ["Documento / série"], ["Emissão NF"], ["Qtd.", true]],
    render: function (r) { return '<td class="mono nowrap">' + fmtDate(r.data_entrada) + "</td><td>" + esc(r.central_entrada) + "</td><td>" + esc(r.fornecedor) + "</td><td>" + esc(r.item) + '</td><td class="mono nowrap">' + esc(r.documento) + (r.serie ? " / " + esc(r.serie) : "") + '</td><td class="mono nowrap">' + fmtDate(r.emissao_nf) + '</td><td class="mono num nowrap">' + fmtNum(r.quantidade) + (r.quantidade != null && r.un_compra ? " " + esc(r.un_compra) : "") + "</td>"; }
  });

  /* ---------------- Aprovação ---------------- */
  var aprFiltro = "pendente_aprovacao", usinasAprov = null;
  var APR_SUB = "Tudo que a usina informa entra aqui primeiro. Só depois de aprovado vai para a Programação de Cimento. Também serve para conferir quem já preencheu.";
  LOADERS.aprov = async function () {
    var el = pane("aprov");
    el.innerHTML = head("Aprovação", APR_SUB) + '<div class="state">Carregando…</div>';
    try {
      var r = await Q(sb.from("solicitacoes_material").select("status").is("deleted_at", null).limit(1000));
      var by = {}; r.data.forEach(function (x) { by[x.status] = (by[x.status] || 0) + 1; });
      setBadge(by.pendente_aprovacao || 0);
      var h = head("Aprovação", APR_SUB) + '<div class="chips" id="stChips">';
      ["pendente_aprovacao", "aguardando_preenchimento", "aprovado", "rejeitado", "cancelado"].forEach(function (s) {
        h += '<button class="chip" type="button" data-st="' + s + '" aria-pressed="' + (s === aprFiltro) + '">' + STATUS[s] + "<small>" + (by[s] || 0) + "</small></button>";
      });
      h += '</div><div id="aprList"></div><div class="msg" id="aprMsg" role="status"></div>' + (canWrite() ? formHtml() : "");
      el.innerHTML = h;
      el.onclick = aprClick;
      if (canWrite()) { $("#solForm").addEventListener("submit", enviarSol); fillUsinas(); }
      listSol();
    } catch (e) { el.innerHTML = head("Aprovação", "") + errBox(e, "aprov"); }
  };
  async function listSol() {
    var box = $("#aprList"); if (!box) return; box.innerHTML = '<div class="state">Carregando…</div>';
    try {
      var r = await Q(sb.from("solicitacoes_material").select("id,usina_nome,data_prevista,material,quantidade,un,pedido,observacao,origem,status,motivo_rejeicao").is("deleted_at", null).eq("status", aprFiltro).order("created_at", { ascending: false }).limit(100));
      if (!r.data.length) { box.innerHTML = '<div class="state"><strong>Nada em “' + STATUS[aprFiltro] + '”</strong>' + (aprFiltro === "pendente_aprovacao" ? "Quando uma usina (ou você) enviar uma solicitação, ela aparece aqui para aprovar ou rejeitar." : "Nenhuma solicitação com este status.") + "</div>"; return; }
      var w = canWrite(), h = '<div class="tablebox"><table><thead><tr><th>Usina</th><th>Data prevista</th><th>Material</th><th class="num">Qtd.</th><th>Pedido</th><th>Origem</th><th>Status</th><th></th></tr></thead><tbody>';
      r.data.forEach(function (x) {
        h += "<tr><td>" + esc(x.usina_nome) + (x.observacao ? '<div class="muted" style="font-size:12px">' + esc(x.observacao) + "</div>" : "") + '</td><td class="mono nowrap">' + fmtDate(x.data_prevista) + "</td><td>" + esc(x.material || "—") + '</td><td class="mono num nowrap">' + fmtNum(x.quantidade) + (x.quantidade != null ? " " + esc(x.un) : "") + '</td><td class="mono">' + esc(x.pedido || "—") + "</td><td>" + (x.origem === "link_externo" ? "Link externo" : "Interno") + '</td><td><span class="pill ' + esc(x.status) + '">' + esc(STATUS[x.status] || x.status) + "</span>" + (x.motivo_rejeicao ? '<div class="muted" style="font-size:12px">' + esc(x.motivo_rejeicao) + "</div>" : "") + '</td><td class="nowrap">';
        if (w && x.status === "pendente_aprovacao") h += '<div class="actions"><button class="btn small" type="button" data-ap="' + esc(x.id) + '">Aprovar</button><button class="btn small ghost" type="button" data-rj="' + esc(x.id) + '">Rejeitar</button></div>';
        h += "</td></tr>";
      });
      box.innerHTML = h + "</tbody></table></div>";
    } catch (e) { box.innerHTML = errBox(e, "aprov"); }
  }
  async function aprClick(ev) {
    var t = ev.target.closest("button"); if (!t) return;
    var msg = function (m, k) { var x = $("#aprMsg"); if (x) { x.className = "msg " + (k || ""); x.textContent = m; } };
    try {
      if (t.dataset.st) { aprFiltro = t.dataset.st; document.querySelectorAll("#stChips .chip").forEach(function (c) { c.setAttribute("aria-pressed", c === t ? "true" : "false"); }); listSol(); return; }
      if (t.dataset.ap && isUuid(t.dataset.ap)) {
        t.disabled = true; t.textContent = "Aprovando…";
        try { await Q(sb.rpc("aprovar_solicitacao", { p_id: t.dataset.ap })); }
        catch (e) { t.disabled = false; t.textContent = "Aprovar"; msg(e.message, "bad"); return; }
        loaded.prog = false; loaded.resumo = false; await LOADERS.aprov(); msg("Aprovado. A carga já está na Programação de Cimento.", "ok"); return;
      }
      if (t.dataset.rj) {
        var td = t.closest("td"); if (td.querySelector(".inline-rej")) return;
        var d = document.createElement("div"); d.className = "inline-rej";
        d.innerHTML = '<input type="text" placeholder="Motivo (opcional)" aria-label="Motivo da rejeição" style="flex:1 1 160px"><button class="btn small bad" type="button" data-rjok="' + esc(t.dataset.rj) + '">Confirmar</button><button class="btn small ghost" type="button" data-rjno="1">Cancelar</button>';
        td.appendChild(d); d.querySelector("input").focus(); return;
      }
      if (t.dataset.rjno) { t.closest(".inline-rej").remove(); return; }
      if (t.dataset.rjok && isUuid(t.dataset.rjok)) {
        var motivo = t.closest(".inline-rej").querySelector("input").value.trim(); t.disabled = true;
        var r = await Q(sb.from("solicitacoes_material").update({ status: "rejeitado", motivo_rejeicao: motivo || null }).eq("id", t.dataset.rjok).eq("status", "pendente_aprovacao").is("deleted_at", null).select("id"));
        if (!r.data.length) { msg("Essa solicitação já não está pendente.", "bad"); t.disabled = false; return; }
        await LOADERS.aprov(); msg("Solicitação rejeitada.", "ok");
      }
    } catch (e) { msg(e.message, "bad"); }
  }
  function formHtml() {
    return '<details class="new"><summary>Nova solicitação</summary><form id="solForm" class="panel" style="margin-top:8px"><div class="grid2">' +
      '<div class="field"><label for="f_usina">Usina</label><select id="f_usina" required><option value="">Carregando…</option></select></div>' +
      '<div class="field"><label for="f_data">Data prevista</label><input type="date" id="f_data" required></div>' +
      '<div class="field"><label for="f_mat">Material</label><input type="text" id="f_mat" placeholder="Ex.: CP V ARI" required></div>' +
      '<div class="field"><label for="f_qtd">Quantidade</label><input type="number" id="f_qtd" min="0" step="0.001" inputmode="decimal"></div>' +
      '<div class="field"><label for="f_un">Unidade</label><select id="f_un"><option>ton</option><option>sc</option><option>m³</option></select></div>' +
      '<div class="field"><label for="f_ped">Pedido</label><input type="text" id="f_ped"></div>' +
      '<div class="field" style="grid-column:1/-1"><label for="f_obs">Observação</label><input type="text" id="f_obs"></div></div>' +
      '<div class="actions" style="margin-top:12px"><button class="btn" type="submit" id="f_go">Enviar para aprovação</button></div><div class="msg" id="formMsg" role="status"></div></form>' +
      '<p class="note">Entra como “Pendente de aprovação”. Nada vai para a Programação até alguém aprovar.</p></details>';
  }
  async function fillUsinas() {
    var sel = $("#f_usina"); if (!sel) return;
    try {
      if (!usinasAprov) usinasAprov = (await Q(sb.from("usinas").select("id,usina").is("deleted_at", null).order("usina"))).data;
      sel.innerHTML = '<option value="">Selecione…</option>' + usinasAprov.map(function (u) { return '<option value="' + esc(u.id) + '">' + esc(u.usina) + "</option>"; }).join("");
    } catch (e) { sel.innerHTML = '<option value="">Não carregou</option>'; }
  }
  async function enviarSol(ev) {
    ev.preventDefault();
    var u = $("#f_usina"), id = u.value, data = $("#f_data").value, mat = $("#f_mat").value.trim(), q = $("#f_qtd").value.trim(), fm = $("#formMsg");
    if (!isUuid(id) || !isDate(data) || !mat) { fm.className = "msg bad"; fm.textContent = "Preencha usina, data e material."; return; }
    var qn = q === "" ? null : Number(q);
    if (qn !== null && !isFinite(qn)) { fm.className = "msg bad"; fm.textContent = "Quantidade inválida."; return; }
    var go = $("#f_go"); go.disabled = true; fm.className = "msg"; fm.textContent = "Enviando…";
    try {
      await Q(sb.from("solicitacoes_material").insert({ empresa_id: ME.empresa_id, usina_id: id, usina_nome: u.options[u.selectedIndex].textContent, data_prevista: data, material: mat, quantidade: qn, un: $("#f_un").value, pedido: $("#f_ped").value.trim() || null, observacao: $("#f_obs").value.trim() || null, origem: "interno", status: "pendente_aprovacao" }));
      aprFiltro = "pendente_aprovacao"; loaded.resumo = false; await LOADERS.aprov(); toast("Solicitação enviada");
    } catch (e) { go.disabled = false; fm.className = "msg bad"; fm.textContent = e.message; }
  }

  /* ---------------- Conta (trocar senha) ---------------- */
  LOADERS.conta = function () {
    var el = pane("conta");
    el.innerHTML = head("Trocar senha", "Use pelo menos 8 caracteres e evite o padrão nome + número.") +
      '<form id="pwForm" class="panel" style="max-width:380px;display:flex;flex-direction:column;gap:12px">' +
      '<div class="field"><label for="pw1">Nova senha</label><input type="password" id="pw1" autocomplete="new-password" minlength="8" required></div>' +
      '<div class="field"><label for="pw2">Repita a nova senha</label><input type="password" id="pw2" autocomplete="new-password" minlength="8" required></div>' +
      '<div class="actions"><button class="btn" type="submit" id="pwGo">Salvar nova senha</button></div><div class="msg" id="pwMsg" role="status"></div></form>';
    $("#pwForm").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var a = $("#pw1").value, b = $("#pw2").value, m = $("#pwMsg");
      if (a.length < 8) { m.className = "msg bad"; m.textContent = "A senha precisa ter pelo menos 8 caracteres."; return; }
      if (a !== b) { m.className = "msg bad"; m.textContent = "As senhas não são iguais."; return; }
      $("#pwGo").disabled = true; m.className = "msg"; m.textContent = "Salvando…";
      var r; try { r = await sb.auth.updateUser({ password: a }); } catch (e) { r = { error: { message: "Failed to fetch" } }; }
      $("#pwGo").disabled = false;
      if (r.error) { m.className = "msg bad"; m.textContent = /different from the old/i.test(r.error.message) ? "A nova senha precisa ser diferente da atual." : friendly(r.error); return; }
      $("#pw1").value = ""; $("#pw2").value = ""; m.className = "msg ok"; m.textContent = "Senha alterada.";
    });
  };

  /* ---------------- início ---------------- */
  (async function boot() {
    try {
      var r = await sb.auth.getSession();
      if (r.data && r.data.session) await enter(r.data.session.user); else show("login");
    } catch (e) { show("login"); }
  })();
})();
