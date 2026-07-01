// ============================================================
// Pickyourtrail · Referral Trail — app.js
// Talks to the Apps Script backend (CONFIG.APPS_SCRIPT_URL),
// renders KPIs / charts / leaderboards / tables / admin panel.
// ============================================================

const STATUS_ORDER = ["Pending","L1 Scheduled","L1 Cleared","L2 Scheduled","L2 Cleared","Selected","Joined","Probation Completed","Rejected"];
const STATUS_COLORS = {
  "Pending":"#E0A527","L1 Scheduled":"#E0A527","L2 Scheduled":"#E0A527",
  "L1 Cleared":"#3563E9","L2 Cleared":"#3563E9","Interview":"#3563E9",
  "Selected":"#00A651","Joined":"#00A651","Probation Completed":"#067A3E",
  "Rejected":"#E4573D"
};

const state = {
  rows: [],
  filtered: [],
  tablePage: 1,
  tableSort: { key:"timestamp", dir:"desc" },
  tableQuery: "",
  adminPage: 1,
  adminQuery: "",
  adminSelected: new Set(),
  adminSession: null, // token from backend after login
  charts: {},
  refreshTimer: null
};

// ---------------- Utilities ----------------
const $ = (sel, ctx=document) => ctx.querySelector(sel);
const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));

function toast(msg, isError=false){
  const t = $("#toast");
  t.textContent = msg;
  t.style.background = isError ? "#E4573D" : "#1E2430";
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=> t.classList.remove("show"), 3200);
}

function fmtDate(ts){
  if(!ts) return "—";
  const d = new Date(ts);
  if(isNaN(d)) return ts;
  return d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
}
function fmtMonth(ts){
  const d = new Date(ts);
  if(isNaN(d)) return "Unknown";
  return d.toLocaleDateString("en-IN",{month:"short", year:"numeric"});
}
function fmtCurrency(n){
  n = Number(n)||0;
  return "₹" + n.toLocaleString("en-IN");
}
function statusClass(status){
  return "status-" + String(status||"Pending").replace(/\s+/g,"-");
}
function isBonusCounted(row){
  // Business rule: bonus only counts once probation is completed AND flagged eligible
  return row.status === "Probation Completed" && String(row.bonusEligibility).toLowerCase() === "yes";
}

// ---------------- API layer ----------------
async function apiGet(action, params={}){
  const url = new URL(CONFIG.APPS_SCRIPT_URL);
  url.searchParams.set("action", action);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method:"GET" });
  if(!res.ok) throw new Error("Network error " + res.status);
  const data = await res.json();
  if(data.error) throw new Error(data.error);
  return data;
}
async function apiPost(action, payload={}){
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method:"POST",
    headers: {"Content-Type":"text/plain;charset=utf-8"}, // avoids CORS preflight on Apps Script
    body: JSON.stringify({ action, ...payload, token: state.adminSession })
  });
  const data = await res.json();
  if(data.error) throw new Error(data.error);
  return data;
}

// ---------------- Data fetch + retry ----------------
async function loadData(retries=2){
  setSync("loading");
  try{
    const data = await apiGet("getData");
    state.rows = (data.rows || []).map(normalizeRow);
    populateFilterOptions();
    applyFilters();
    setSync("live");
  }catch(err){
    console.error(err);
    if(retries > 0){
      await new Promise(r=>setTimeout(r, 1500));
      return loadData(retries-1);
    }
    setSync("error");
    toast("Could not reach the Google Sheet backend. Check config.js.", true);
  }
}
function normalizeRow(r){
  return {
    rowId: r.rowId,
    timestamp: r.timestamp,
    employee: r.employee || "Unknown",
    candidate: r.candidate || "—",
    resumeUrl: r.resumeUrl || "",
    position: r.position || "Unspecified",
    status: r.status || "Pending",
    bonusEligibility: r.bonusEligibility || "No",
    bonusAmount: Number(r.bonusAmount)||0,
    lastUpdatedBy: r.lastUpdatedBy || "",
    lastUpdatedOn: r.lastUpdatedOn || ""
  };
}
function setSync(status){
  const dot = $("#syncDot"), text = $("#syncText");
  dot.className = "dot";
  if(status==="live"){ dot.classList.add("live"); text.textContent = "Live · updated " + new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}); }
  else if(status==="loading"){ text.textContent = "Syncing…"; }
  else { dot.classList.add("err"); text.textContent = "Sync failed — retrying"; }
}

// ---------------- Filters ----------------
function populateFilterOptions(){
  const months = [...new Set(state.rows.map(r=>fmtMonth(r.timestamp)))];
  const positions = [...new Set(state.rows.map(r=>r.position))].sort();
  const statuses = [...new Set(state.rows.map(r=>r.status))].sort();
  fillSelect("#filterMonth", months, "All months");
  fillSelect("#filterPosition", positions, "All positions");
  fillSelect("#filterStatus", statuses, "All statuses");

  const dl = $("#employeeList");
  dl.innerHTML = "";
  [...new Set(state.rows.map(r=>r.employee))].sort().forEach(name=>{
    const opt = document.createElement("option"); opt.value = name; dl.appendChild(opt);
  });
}
function fillSelect(sel, values, label){
  const el = $(sel);
  const current = el.value;
  el.innerHTML = `<option value="">${label}</option>` + values.map(v=>`<option value="${v}">${v}</option>`).join("");
  if(values.includes(current)) el.value = current;
}
function applyFilters(){
  const month = $("#filterMonth").value;
  const position = $("#filterPosition").value;
  const status = $("#filterStatus").value;
  state.filtered = state.rows.filter(r=>{
    if(month && fmtMonth(r.timestamp) !== month) return false;
    if(position && r.position !== position) return false;
    if(status && r.status !== status) return false;
    return true;
  });
  renderAll();
}

// ---------------- Rendering: Overview ----------------
function renderAll(){
  renderKPIs();
  renderCharts();
  renderHallOfFame();
  renderLeaderboards();
  renderTable();
  renderAdminTable();
}

function renderKPIs(){
  const rows = state.filtered;
  const now = new Date();
  const thisMonthKey = now.toLocaleDateString("en-IN",{month:"short",year:"numeric"});
  const totalReferrals = rows.length;
  const thisMonth = rows.filter(r=>fmtMonth(r.timestamp)===thisMonthKey).length;
  const uniqueReferrers = new Set(rows.map(r=>r.employee)).size;
  const selected = rows.filter(r=>["Selected","Joined","Probation Completed"].includes(r.status)).length;
  const rejected = rows.filter(r=>r.status==="Rejected").length;
  const inProcess = rows.filter(r=>!["Selected","Joined","Probation Completed","Rejected"].includes(r.status)).length;
  const totalBonus = rows.filter(isBonusCounted).reduce((s,r)=>s+r.bonusAmount,0);
  const newJoiners = rows.filter(r=>r.status==="Joined" || r.status==="Probation Completed").length;

  const cards = [
    ["🧭","Total Referrals", totalReferrals],
    ["📅","Referrals This Month", thisMonth],
    ["🧑‍🤝‍🧑","Unique Referrers", uniqueReferrers],
    ["✅","Selected Candidates", selected],
    ["🚫","Rejected Candidates", rejected],
    ["⏳","Candidates In Process", inProcess],
    ["💰","Total Referral Bonus Earned", fmtCurrency(totalBonus)],
    ["🎒","New Joiner Referrals", newJoiners],
  ];
  $("#kpiGrid").innerHTML = cards.map(([icon,label,value])=>`
    <div class="kpi-card">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-label">${label}</div>
    </div>`).join("");
}

function renderCharts(){
  const rows = state.filtered;

  // Monthly trend
  const monthMap = {};
  rows.forEach(r=>{ const m=fmtMonth(r.timestamp); monthMap[m]=(monthMap[m]||0)+1; });
  const monthKeys = Object.keys(monthMap).sort((a,b)=> new Date("1 "+a) - new Date("1 "+b));
  drawChart("chartTrend","line", monthKeys, [{label:"Referrals", data:monthKeys.map(k=>monthMap[k]), borderColor:"#00A651", backgroundColor:"rgba(0,166,81,0.12)", fill:true, tension:.35}]);

  // Status distribution
  const statusMap = {};
  rows.forEach(r=>{ statusMap[r.status]=(statusMap[r.status]||0)+1; });
  const sKeys = Object.keys(statusMap);
  drawChart("chartStatus","doughnut", sKeys, [{data:sKeys.map(k=>statusMap[k]), backgroundColor:sKeys.map(k=>STATUS_COLORS[k]||"#9AA3B0")}]);

  // Position-wise
  const posMap = {};
  rows.forEach(r=>{ posMap[r.position]=(posMap[r.position]||0)+1; });
  const pKeys = Object.keys(posMap).sort((a,b)=>posMap[b]-posMap[a]).slice(0,8);
  drawChart("chartPosition","bar", pKeys, [{label:"Referrals", data:pKeys.map(k=>posMap[k]), backgroundColor:"#00A651", borderRadius:6}]);

  // Bonus distribution (by position, only counted bonuses)
  const bonusMap = {};
  rows.filter(isBonusCounted).forEach(r=>{ bonusMap[r.position]=(bonusMap[r.position]||0)+r.bonusAmount; });
  const bKeys = Object.keys(bonusMap);
  drawChart("chartBonus","bar", bKeys, [{label:"Bonus (₹)", data:bKeys.map(k=>bonusMap[k]), backgroundColor:"#F2A65A", borderRadius:6}], true);
}

function drawChart(canvasId, type, labels, datasets, isCurrency=false){
  const ctx = $("#"+canvasId);
  if(!ctx) return;
  if(state.charts[canvasId]) state.charts[canvasId].destroy();
  state.charts[canvasId] = new Chart(ctx, {
    type,
    data: { labels, datasets },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{ display: type==="doughnut", position:"bottom", labels:{boxWidth:10, font:{size:11}} },
        tooltip:{ callbacks: isCurrency ? { label: (c)=> " ₹"+c.parsed.y.toLocaleString("en-IN") } : {} }
      },
      scales: type==="doughnut" ? {} : {
        y:{ beginAtZero:true, grid:{color:"#EEF4F0"}, ticks:{font:{size:11}} },
        x:{ grid:{display:false}, ticks:{font:{size:11}} }
      }
    }
  });
}

function renderHallOfFame(){
  const rows = state.filtered;
  const now = new Date();
  const thisMonthKey = now.toLocaleDateString("en-IN",{month:"short",year:"numeric"});
  const monthRows = rows.filter(r=>fmtMonth(r.timestamp)===thisMonthKey);

  const topReferrer = topBy(monthRows, r=>r.employee, ()=>1);
  const topBonus = topBy(monthRows.filter(isBonusCounted), r=>r.employee, r=>r.bonusAmount);
  const topSuccess = topBy(monthRows.filter(r=>["Selected","Joined","Probation Completed"].includes(r.status)), r=>r.employee, ()=>1);

  const cards = [
    ["🏆","Top Referrer", topReferrer.name, topReferrer.value + " referrals"],
    ["💸","Highest Bonus Earner", topBonus.name, fmtCurrency(topBonus.value)],
    ["🎯","Most Successful Referrer", topSuccess.name, topSuccess.value + " hires"],
  ];
  $("#hofGrid").innerHTML = cards.map(([icon,title,name,meta])=>`
    <div class="hof-card">
      <div class="hof-badge">${icon}</div>
      <div class="hof-title">${title}</div>
      <div class="hof-name">${name || "—"}</div>
      <div class="hof-meta">${name ? meta : "No data this month"}</div>
    </div>`).join("");
}

function topBy(rows, keyFn, valFn){
  const map = {};
  rows.forEach(r=>{ const k=keyFn(r); map[k]=(map[k]||0)+valFn(r); });
  const entries = Object.entries(map).sort((a,b)=>b[1]-a[1]);
  return entries.length ? {name:entries[0][0], value:entries[0][1]} : {name:null, value:0};
}

function renderLeaderboards(){
  const rows = state.filtered;
  renderLB("#lbTop", rankMap(rows, r=>r.employee, ()=>1), v=>v+" referrals");
  renderLB("#lbBonus", rankMap(rows.filter(isBonusCounted), r=>r.employee, r=>r.bonusAmount), fmtCurrency);
  renderLB("#lbSuccess", rankMap(rows.filter(r=>["Selected","Joined","Probation Completed"].includes(r.status)), r=>r.employee, ()=>1), v=>v+" hires");
}
function rankMap(rows, keyFn, valFn, top=6){
  const map = {};
  rows.forEach(r=>{ const k=keyFn(r); map[k]=(map[k]||0)+valFn(r); });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,top);
}
function renderLB(sel, entries, fmtVal){
  const el = $(sel);
  if(!entries.length){ el.innerHTML = `<li class="muted">No data yet</li>`; return; }
  el.innerHTML = entries.map(([name,val],i)=>`
    <li>
      <span class="lb-rank ${i===1?'r2':i===2?'r3':''}">${i+1}</span>
      <span class="lb-name">${name}</span>
      <span class="lb-value">${fmtVal(val)}</span>
    </li>`).join("");
}

// ---------------- Live Referral Table ----------------
function getTableRows(){
  let rows = [...state.filtered];
  const q = state.tableQuery.toLowerCase();
  if(q){
    rows = rows.filter(r =>
      r.employee.toLowerCase().includes(q) ||
      r.candidate.toLowerCase().includes(q) ||
      r.position.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q));
  }
  const { key, dir } = state.tableSort;
  rows.sort((a,b)=>{
    let av=a[key], bv=b[key];
    if(key==="timestamp"){ av=new Date(av); bv=new Date(bv); }
    if(key==="bonusAmount"){ av=Number(av); bv=Number(bv); }
    if(av < bv) return dir==="asc" ? -1 : 1;
    if(av > bv) return dir==="asc" ? 1 : -1;
    return 0;
  });
  return rows;
}
function renderTable(){
  const rows = getTableRows();
  const pageSize = CONFIG.TABLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(rows.length/pageSize));
  state.tablePage = Math.min(state.tablePage, totalPages);
  const start = (state.tablePage-1)*pageSize;
  const pageRows = rows.slice(start, start+pageSize);

  $("#tableBody").innerHTML = pageRows.map(r=>`
    <tr>
      <td>${fmtDate(r.timestamp)}</td>
      <td>${r.employee}</td>
      <td>${r.candidate}</td>
      <td>${r.position}</td>
      <td><span class="status-badge ${statusClass(r.status)}">${r.status}</span></td>
      <td>${r.bonusEligibility}</td>
      <td class="mono">${r.bonusAmount ? fmtCurrency(r.bonusAmount) : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="muted" style="text-align:center; padding:24px;">No referrals match your filters.</td></tr>`;

  renderPagination("#pagination", state.tablePage, totalPages, (p)=>{ state.tablePage=p; renderTable(); });
}
function renderPagination(sel, page, totalPages, onClick){
  const el = $(sel);
  let html = "";
  for(let p=1; p<=totalPages; p++){
    if(totalPages>7 && p!==1 && p!==totalPages && Math.abs(p-page)>1){ if(p===2||p===totalPages-1) html+=`<span class="page-btn" style="border:none;">…</span>`; continue; }
    html += `<button class="page-btn ${p===page?'active':''}" data-page="${p}">${p}</button>`;
  }
  el.innerHTML = html;
  $$(".page-btn[data-page]", el).forEach(b=> b.onclick = ()=> onClick(Number(b.dataset.page)));
}

// ---------------- Employee Search ----------------
function renderEmployeeSearch(name){
  if(!name){ $("#employeeResult").classList.add("hidden"); $("#employeeEmptyHint").classList.remove("hidden"); return; }
  const rows = state.rows.filter(r=>r.employee.toLowerCase() === name.toLowerCase());
  if(!rows.length){ $("#employeeResult").classList.add("hidden"); $("#employeeEmptyHint").classList.remove("hidden"); $("#employeeEmptyHint").textContent = `No referrals found for "${name}".`; return; }

  $("#employeeEmptyHint").classList.add("hidden");
  $("#employeeResult").classList.remove("hidden");

  const total = rows.length;
  const selected = rows.filter(r=>["Selected","Joined","Probation Completed"].includes(r.status)).length;
  const rejected = rows.filter(r=>r.status==="Rejected").length;
  const pending = total - selected - rejected;
  const bonus = rows.filter(isBonusCounted).reduce((s,r)=>s+r.bonusAmount,0);

  const cards = [
    ["Total Referrals", total], ["Selected", selected], ["Rejected", rejected],
    ["Pending", pending], ["Bonus Earned", fmtCurrency(bonus)]
  ];
  $("#employeeKpis").innerHTML = cards.map(([label,val])=>`
    <div class="kpi-card"><div class="kpi-value">${val}</div><div class="kpi-label">${label}</div></div>`).join("");

  $("#employeeHistoryBody").innerHTML = rows
    .sort((a,b)=> new Date(b.timestamp)-new Date(a.timestamp))
    .map(r=>`
      <tr>
        <td>${fmtDate(r.timestamp)}</td>
        <td>${r.candidate}</td>
        <td>${r.position}</td>
        <td><span class="status-badge ${statusClass(r.status)}">${r.status}</span></td>
        <td>${r.bonusEligibility}</td>
        <td class="mono">${r.bonusAmount ? fmtCurrency(r.bonusAmount) : "—"}</td>
      </tr>`).join("");
}

// ---------------- Admin Panel ----------------
function getAdminRows(){
  let rows = [...state.rows];
  const q = state.adminQuery.toLowerCase();
  if(q){
    rows = rows.filter(r => r.employee.toLowerCase().includes(q) || r.candidate.toLowerCase().includes(q) || r.position.toLowerCase().includes(q));
  }
  return rows.sort((a,b)=> new Date(b.timestamp)-new Date(a.timestamp));
}
function renderAdminTable(){
  if(!state.adminSession) return;
  const rows = getAdminRows();
  const pageSize = CONFIG.TABLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(rows.length/pageSize));
  state.adminPage = Math.min(state.adminPage, totalPages);
  const start = (state.adminPage-1)*pageSize;
  const pageRows = rows.slice(start, start+pageSize);

  $("#adminTableBody").innerHTML = pageRows.map(r=>`
    <tr>
      <td><input type="checkbox" class="admin-row-check" data-id="${r.rowId}" ${state.adminSelected.has(r.rowId)?"checked":""}></td>
      <td>${fmtDate(r.timestamp)}</td>
      <td>${r.employee}</td>
      <td>${r.candidate}</td>
      <td>${r.position}</td>
      <td><span class="status-badge ${statusClass(r.status)}">${r.status}</span></td>
      <td>${r.bonusEligibility}</td>
      <td class="mono">${r.bonusAmount ? fmtCurrency(r.bonusAmount) : "—"}</td>
      <td style="font-size:11px; color:var(--slate);">${r.lastUpdatedBy ? r.lastUpdatedBy + " · " + fmtDate(r.lastUpdatedOn) : "—"}</td>
      <td><button class="btn small ghost" data-edit="${r.rowId}">Edit</button></td>
    </tr>`).join("") || `<tr><td colspan="10" class="muted" style="text-align:center; padding:24px;">No referrals found.</td></tr>`;

  $$(".admin-row-check").forEach(cb => cb.onchange = () => {
    const id = cb.dataset.id;
    cb.checked ? state.adminSelected.add(id) : state.adminSelected.delete(id);
  });
  $$("[data-edit]").forEach(b => b.onclick = () => openEditModal(b.dataset.edit));

  renderPagination("#adminPagination", state.adminPage, totalPages, (p)=>{ state.adminPage=p; renderAdminTable(); });
}

function openEditModal(rowId){
  const row = state.rows.find(r=>r.rowId===rowId);
  if(!row) return;
  $("#editModalBody").innerHTML = `
    <label>Status</label>
    <select id="editStatus">${STATUS_ORDER.map(s=>`<option value="${s}" ${s===row.status?"selected":""}>${s}</option>`).join("")}</select>
    <label>Bonus Eligibility</label>
    <select id="editBonusEligibility">
      <option value="No" ${row.bonusEligibility==="No"?"selected":""}>No</option>
      <option value="Yes" ${row.bonusEligibility==="Yes"?"selected":""}>Yes</option>
    </select>
    <label>Bonus Amount (₹)</label>
    <input type="number" id="editBonusAmount" value="${row.bonusAmount||0}">
    <p class="muted" style="margin-top:4px;">Setting status to <strong>Probation Completed</strong> automatically marks the referral bonus-eligible and includes it in the leaderboards and KPIs.</p>
  `;
  $("#editModal").classList.remove("hidden");
  $("#editModal").dataset.rowId = rowId;
}
function closeEditModal(){ $("#editModal").classList.add("hidden"); }

async function saveEdit(){
  const rowId = $("#editModal").dataset.rowId;
  let status = $("#editStatus").value;
  let bonusEligibility = $("#editBonusEligibility").value;
  const bonusAmount = Number($("#editBonusAmount").value)||0;
  if(status === "Probation Completed") bonusEligibility = "Yes"; // business rule

  showConfirm(`Save changes for this referral? Status will be set to "${status}".`, async ()=>{
    try{
      await apiPost("updateReferral", { rowId, status, bonusEligibility, bonusAmount });
      toast("Referral updated.");
      closeEditModal();
      await loadData();
    }catch(err){ toast("Update failed: " + err.message, true); }
  });
}

function showConfirm(text, onConfirm){
  $("#confirmModalText").textContent = text;
  $("#confirmModal").classList.remove("hidden");
  $("#confirmSaveBtn").onclick = async ()=>{ $("#confirmModal").classList.add("hidden"); await onConfirm(); };
  $("#confirmCancelBtn").onclick = ()=> $("#confirmModal").classList.add("hidden");
}

async function bulkUpdate(){
  if(!state.adminSelected.size){ toast("Select at least one referral first.", true); return; }
  const status = prompt(`Set status for ${state.adminSelected.size} selected referrals to:\n(${STATUS_ORDER.join(", ")})`);
  if(!status || !STATUS_ORDER.includes(status)){ if(status) toast("Not a valid status.", true); return; }
  showConfirm(`Apply "${status}" to ${state.adminSelected.size} referrals?`, async ()=>{
    try{
      await apiPost("bulkUpdate", { rowIds:[...state.adminSelected], status });
      toast("Bulk update complete.");
      state.adminSelected.clear();
      await loadData();
    }catch(err){ toast("Bulk update failed: " + err.message, true); }
  });
}

async function viewAuditTrail(){
  try{
    const data = await apiGet("getAuditTrail", { token: state.adminSession });
    const rows = data.entries || [];
    const body = rows.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Who</th><th>Row</th><th>Change</th></tr></thead><tbody>${
          rows.map(e=>`<tr><td>${fmtDate(e.when)}</td><td>${e.who}</td><td>${e.candidate||e.rowId}</td><td>${e.change}</td></tr>`).join("")
        }</tbody></table></div>`
      : `<p class="muted">No audit entries yet.</p>`;
    $("#editModalBody").innerHTML = body;
    $("#editModal").querySelector(".modal-head h3").textContent = "Audit Trail";
    $("#editModal").dataset.rowId = "";
    $("#saveEditBtn").style.display = "none";
    $("#editModal").classList.remove("hidden");
  }catch(err){ toast("Could not load audit trail: " + err.message, true); }
}

// ---------------- Admin login ----------------
async function adminLogin(){
  const pw = $("#adminPassword").value.trim();
  if(!pw){ return; }
  try{
    const data = await apiPost("login", { password: pw });
    state.adminSession = data.token;
    $("#adminLoginBox").classList.add("hidden");
    $("#adminPanel").classList.remove("hidden");
    $("#adminLoginError").textContent = "";
    renderAdminTable();
  }catch(err){
    $("#adminLoginError").textContent = "Incorrect password. Please try again.";
  }
}
function adminLogout(){
  state.adminSession = null;
  $("#adminLoginBox").classList.remove("hidden");
  $("#adminPanel").classList.add("hidden");
  $("#adminPassword").value = "";
}

// ---------------- Export ----------------
function exportCSV(rows, filename){
  const headers = ["Date","Employee","Candidate","Position","Status","Bonus Eligibility","Bonus Amount"];
  const lines = [headers.join(",")].concat(rows.map(r=>[
    fmtDate(r.timestamp), r.employee, r.candidate, r.position, r.status, r.bonusEligibility, r.bonusAmount
  ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")));
  const blob = new Blob([lines.join("\n")], {type:"text/csv;charset=utf-8;"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

// ---------------- Tabs ----------------
function switchTab(tabId){
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab===tabId));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-"+tabId));
}

// ---------------- Init / event wiring ----------------
function init(){
  $$(".tab").forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $("#refreshBtn").onclick = () => loadData();
  $("#filterMonth").onchange = applyFilters;
  $("#filterPosition").onchange = applyFilters;
  $("#filterStatus").onchange = applyFilters;

  $("#tableSearch").oninput = (e)=>{ state.tableQuery = e.target.value; state.tablePage=1; renderTable(); };
  $$("#referralTable thead th[data-key]").forEach(th => th.onclick = ()=>{
    const key = th.dataset.key;
    state.tableSort = { key, dir: state.tableSort.key===key && state.tableSort.dir==="asc" ? "desc" : "asc" };
    renderTable();
  });
  $("#exportCsvBtn").onclick = ()=> exportCSV(getTableRows(), "referrals.csv");
  $("#exportPdfBtn").onclick = ()=> window.print();

  $("#employeeSearchInput").oninput = (e)=> renderEmployeeSearch(e.target.value.trim());

  $("#adminLoginBtn").onclick = adminLogin;
  $("#adminPassword").addEventListener("keydown", e=>{ if(e.key==="Enter") adminLogin(); });
  $("#adminLogoutBtn").onclick = adminLogout;
  $("#adminSearch").oninput = (e)=>{ state.adminQuery = e.target.value; state.adminPage=1; renderAdminTable(); };
  $("#adminSelectAll").onchange = (e)=>{
    const rows = getAdminRows();
    if(e.target.checked) rows.forEach(r=>state.adminSelected.add(r.rowId));
    else state.adminSelected.clear();
    renderAdminTable();
  };
  $("#adminBulkBtn").onclick = bulkUpdate;
  $("#adminExportBtn").onclick = ()=> exportCSV(getAdminRows(), "referrals_admin_export.csv");
  $("#adminAuditBtn").onclick = viewAuditTrail;

  $("#closeModalBtn").onclick = closeEditModal;
  $("#cancelEditBtn").onclick = closeEditModal;
  $("#saveEditBtn").onclick = saveEdit;
  $("#editModal").onclick = (e)=>{ if(e.target.id==="editModal"){} };

  loadData();
  state.refreshTimer = setInterval(loadData, CONFIG.REFRESH_INTERVAL_MS);
}

document.addEventListener("DOMContentLoaded", init);
