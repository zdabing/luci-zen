'use strict';
'require baseclass';

/* Shared app surfaces follow Z Design System v2.0.0 tokens,
 * with Light Meridian + Aurora Blue fallbacks when another LuCI theme is used. */
return baseclass.extend({
	inject() {
		if (document.getElementById('zen-traffic-page-css')) return;
		const style = E('style', { id: 'zen-traffic-page-css' });
		style.textContent = `
.zen-analysis-tabs { display:flex; gap:8px; flex-wrap:wrap; margin:20px 0 24px; border-bottom:1px solid var(--zt-line); }
.zen-analysis-tabs button { border:0; border-bottom:2px solid transparent; background:transparent; color:var(--zt-muted); padding:12px 16px; font:inherit; min-height:44px; cursor:pointer; }
.zen-analysis-tabs button[aria-selected="true"] { color:var(--accent-strong,#1d4ed8); border-bottom-color:var(--accent,#2563eb); }
.zen-analysis-tabs button:focus-visible { outline:2px solid var(--accent,#2563eb); outline-offset:2px; }
.zen-traffic-page [role="tabpanel"][hidden], .zen-traffic-page button[hidden] { display:none!important; }
.zen-reset-devices { max-height:45dvh; overflow:auto; margin:16px 0; }
.zen-reset-device { display:flex; align-items:center; gap:12px; min-height:52px; padding:8px 0; cursor:pointer; }
.zen-reset-device input { width:18px!important;height:18px!important;flex:none; }
.zen-reset-device span { display:grid;gap:4px;min-width:0;overflow-wrap:anywhere; }
.zen-reset-device small { color:var(--zt-muted); }
.zen-date-picker { display:block; min-width:0; width:100%; }
.zen-date-picker>input[hidden] { display:none!important; }
.zen-traffic-page .zen-date-trigger { display:flex; align-items:center; justify-content:space-between; gap:14px; width:100%; min-height:40px; border:1px solid var(--line,#e4e7ee); border-radius:var(--radius-control,12px); padding:8px 12px; background:var(--bg-panel,#ffffff); color:var(--text,#232326); font:inherit; font-size:13px; font-variant-numeric:tabular-nums; text-align:left; cursor:pointer; }
.zen-traffic-page .zen-date-trigger:hover { border-color:color-mix(in srgb,var(--accent,#2563eb) 45%,var(--line,#e4e7ee)); }
.zen-date-trigger svg { width:17px; height:17px; color:var(--text-secondary,#62626c); flex:none; }
.zen-date-trigger[aria-expanded="true"] { border-color:var(--accent,#2563eb); box-shadow:0 0 0 3px var(--focus-ring,rgba(37,99,235,0.24)); }
.zen-date-dialog { position:fixed; inset:auto; margin:0!important; width:min(320px,calc(100vw - 24px)); max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto; padding:16px; border:1px solid var(--line,#e4e7ee); border-radius:var(--radius-micro,14px); background:var(--bg-panel,#ffffff); color:var(--text,#232326); font:13px/1.4 var(--font,system-ui,sans-serif); box-shadow:var(--shadow-menu,0 4px 16px rgba(16,24,40,0.08),0 12px 32px rgba(16,24,40,0.08)); }
.zen-date-dialog::backdrop { background:transparent; }
.zen-date-heading { display:flex; align-items:center; gap:5px; margin-bottom:14px; }
.zen-date-month { flex:1; font-size:15px; font-weight:600; letter-spacing:-.2px; }
.zen-date-dialog button { display:inline-flex; align-items:center; justify-content:center; min-width:0; margin:0; padding:0; border:0; background:transparent; color:inherit; font:inherit; font-variant-numeric:tabular-nums; cursor:pointer; box-shadow:none; }
.zen-date-dialog .zen-date-nav { width:32px; height:32px; flex:none; border-radius:8px; background:var(--bg-nested,#f8f9fb); }
.zen-date-nav svg { width:16px; height:16px; display:block; }
.zen-date-weekdays, .zen-date-days { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:4px; text-align:center; }
.zen-date-weekdays { color:var(--text-muted,#6b6b75); font-size:11px; margin-bottom:6px; }
.zen-date-weekdays span { padding:4px 0; }
.zen-date-dialog .zen-date-day { height:36px; min-height:36px; border:1px solid transparent; border-radius:9px; font-size:13px; }
.zen-date-dialog .zen-date-day.is-outside { color:var(--text-muted,#6b6b75); }
.zen-date-dialog .zen-date-day[aria-current="date"] { border-color:var(--accent,#2563eb); color:var(--accent-strong,#1d4ed8); }
.zen-date-dialog .zen-date-day[aria-pressed="true"] { background:var(--accent,#2563eb); color:var(--on-accent,#ffffff); border-color:transparent; font-weight:600; }
.zen-date-dialog button:disabled { opacity:.28; cursor:default; }
.zen-date-dialog button:not(:disabled):hover { background:var(--bg-nested,#f8f9fb); color:var(--text,#232326); }
.zen-date-dialog .zen-date-day[aria-pressed="true"]:hover { background:var(--accent-press,#1d4ed8); color:var(--on-accent,#ffffff); }
.zen-date-dialog button:focus-visible, .zen-date-trigger:focus-visible { outline:2px solid var(--accent,#2563eb); outline-offset:2px; }
.zen-date-footer { display:flex; justify-content:flex-end; border-top:1px solid var(--line,#e4e7ee); padding-top:10px; margin-top:12px; }
.zen-date-dialog .zen-date-today { min-height:32px; padding:6px 12px; border-radius:9px; background:var(--accent-soft,#eff6ff); color:var(--accent-strong,#1d4ed8); font-size:12px; font-weight:550; }

.zen-traffic-page { --zt-panel:var(--bg-panel,#ffffff); --zt-nested:var(--bg-nested,#f8f9fb); --zt-text:var(--text,#232326); --zt-muted:var(--text-secondary,#62626c); --zt-line:var(--line,#e4e7ee); --zt-dl:var(--dl,#2563eb); --zt-ul:var(--ul,#f97316); color:var(--zt-text); font-family:var(--font,system-ui,sans-serif); min-width:0; }
.zen-traffic-page>h2 { font-size:24px; font-weight:650; letter-spacing:-.025em; border:0; padding:0; margin:0 0 10px; }
.zen-traffic-page>.cbi-map-descr { color:var(--zt-muted); font-size:13px; line-height:1.65; margin:0 0 20px; max-width:80ch; }
.zen-traffic-page>.cbi-section, .zen-traffic-page>[role="tabpanel"]>.cbi-section { background:var(--zt-panel); border:1px solid var(--zt-line); border-radius:var(--radius-card,20px); padding:22px 24px; margin:0 0 18px; min-width:0; box-shadow:var(--shadow-card,none); }
.zen-traffic-page button { min-height:40px; border-radius:var(--radius-control,12px); font-size:13px; box-shadow:none; }
.zen-traffic-page button:focus-visible, .zen-traffic-page select:focus-visible { outline:2px solid var(--accent,#2563eb); outline-offset:2px; }
.zen-traffic-page select, .zen-traffic-page input { min-height:40px; min-width:0; max-width:100%; border-radius:var(--radius-control,12px); font-size:13px; }
.zen-traffic-page .zen-tf-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; padding:0; border:0; background:transparent; box-shadow:none; }
.zen-tf-sum-item { min-width:0; padding:18px 20px; border:1px solid var(--zt-line); border-radius:var(--radius-micro,14px); background:var(--zt-panel); }
.zen-tf-sum-label { font-size:12px; color:var(--zt-muted); margin-bottom:8px; line-height:1.5; }
.zen-tf-sum-value { font-size:clamp(20px,2.2vw,28px); font-weight:650; letter-spacing:-.025em; font-variant-numeric:tabular-nums; white-space:nowrap; }
.zen-tf-dl { color:var(--zt-dl); }
.zen-tf-ul { color:var(--zt-ul); }
.zen-tf-status { font-size:13px; color:var(--zt-muted); margin:0 0 14px; }
.zen-tf-status:empty { display:none; }
.zen-tf-list-head { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:14px; }
.zen-tf-list-head h3 { font-size:16px; font-weight:650; margin:0; border:0; padding:0; }
.zen-tf-count { font-size:12px; color:var(--zt-muted); }
.zen-tf-table { width:100%; border-collapse:collapse; table-layout:fixed; }
.zen-tf-table th { font-size:12px; color:var(--zt-muted); font-weight:500; background:transparent; padding:10px 12px; text-align:left; }
.zen-tf-table td { padding:14px 12px; border-bottom:1px solid var(--zt-line); background:transparent; font-size:13px; vertical-align:middle; min-width:0; }
.zen-tf-table th:first-child { width:30%; }
.zen-tf-table th:last-child { width:56px; }
.zen-tf-table .th-right, .zen-tf-table .td-right { text-align:right; }
.zen-tf-table .zen-tf-device-name { display:block; font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.zen-tf-address { display:block; margin-top:4px; font-size:12px; color:var(--zt-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.zen-tf-online { display:inline-flex; align-items:center; gap:6px; color:var(--zt-muted); font-size:12px; }
.zen-tf-online::before { content:''; width:6px; height:6px; flex:none; border-radius:50%; background:var(--ok,#24753c); }
.zen-tf-offline .zen-tf-online::before { background:var(--text-muted,#6b6b75); }
.zen-tf-offline .zen-tf-device-name { color:var(--zt-muted); }
.zen-tf-number { font-variant-numeric:tabular-nums; white-space:nowrap; font-weight:550; }
.zen-tf-mobile-label { display:none; }
.zen-traffic-page .zen-tf-expand { width:40px; min-width:40px; padding:0; background:var(--zt-panel); border:1px solid var(--zt-line); font-size:18px; }
.zen-tf-detail-row td { padding:0 12px 18px; }
.zen-tf-detail { padding:16px 18px; border:1px solid var(--zt-line); border-radius:var(--radius-micro,14px); background:var(--zt-panel); font-size:12px; }
.zen-tf-detail-identities { color:var(--zt-muted); display:grid; gap:6px; margin-bottom:16px; overflow-wrap:anywhere; line-height:1.6; }
.zen-tf-detail-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
.zen-tf-detail-stats strong { display:block; font-size:12px; font-weight:500; color:var(--zt-muted); margin-bottom:6px; }
.zen-tf-detail-stats span { display:block; font-size:14px; font-weight:550; line-height:1.7; font-variant-numeric:tabular-nums; }
.zen-tf-detail-last { margin:14px 0; color:var(--zt-muted); }
.zen-tf-detail-actions { display:flex; flex-wrap:wrap; gap:8px; }
.zen-tf-name-field { display:flex; flex-direction:column; gap:8px; font-size:13px; margin:16px 0; }
.zen-tf-name-field input { width:100%; min-height:42px; }
.zen-tf-modal-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
.zen-tf-modal-actions button { min-height:40px; border-radius:var(--radius-control,12px); padding:8px 16px; }
.zen-tf-empty { text-align:center; color:var(--zt-muted); padding:28px 16px; font-size:13px; }
.zen-traffic-page .zen-tf-controls { gap:12px; }
.zen-traffic-page .zen-tf-tabs { background:var(--zt-nested); border:1px solid var(--zt-line); padding:3px; border-radius:var(--radius-control,12px); gap:3px; display:inline-flex; }
.zen-traffic-page .zen-tf-tabs button { border:0; background:transparent; padding:6px 14px; min-height:34px; border-radius:9px; color:var(--zt-muted); }
.zen-traffic-page .zen-tf-tabs .important { background:var(--zt-panel); color:var(--accent-strong,#1d4ed8); font-weight:600; box-shadow:0 1px 3px rgba(16,24,40,0.08); }
.zen-traffic-page .zen-tf-chart-svg { background:var(--zt-panel); border-radius:var(--radius-micro,14px); }
.zen-traffic-page .zen-tf-legend { padding-top:14px; gap:18px; }
.zen-tf-chart, .zen-rt-chart { position:relative; }
.zen-tf-chart svg, .zen-rt-chart svg { user-select:none; }
.zen-traffic-page .zen-history-tip { position:absolute; top:8px; left:8px; z-index:2; width:max-content; max-width:calc(100% - 16px); box-sizing:border-box; padding:8px 12px; border:1px solid var(--zt-line); border-radius:10px; background:var(--zt-panel); color:var(--zt-text); box-shadow:var(--shadow-menu,0 4px 16px rgba(16,24,40,0.08)); font-size:12px; line-height:1.6; font-variant-numeric:tabular-nums; pointer-events:none; }
.zen-traffic-page .zen-history-tip[hidden] { display:none; }
.zen-rt-cross { stroke:currentColor; opacity:.4; stroke-dasharray:3 3; pointer-events:none; }
.zen-rt-readout { font-size:13px; font-variant-numeric:tabular-nums; color:var(--zt-muted); }
.zen-traffic-page .zen-rt-summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin-bottom:18px; }
.zen-rt-summary>div { background:var(--zt-panel); border:1px solid var(--zt-line); padding:16px 18px; border-radius:var(--radius-micro,14px); min-width:0; }
.zen-rt-summary span { color:var(--zt-muted); font-size:12px; line-height:1.5; }
.zen-traffic-page .zen-rt-summary strong { margin-top:6px; font-size:24px; letter-spacing:-.025em; }
.zen-traffic-page .zen-rt-chart { background:var(--zt-panel); border:1px solid var(--zt-line); border-radius:var(--radius-micro,14px); padding:12px 0; }
.zen-traffic-page .zen-rt-field { min-width:0; flex:1 1 150px; }
.zen-traffic-page .zen-rt-field[hidden] { display:none; }
.zen-traffic-page .zen-rt-field input, .zen-traffic-page .zen-rt-field select { width:100%; }
.zen-traffic-page .zen-rt-table { width:100%; table-layout:fixed; }
.zen-rt-table th:first-child { width:42%; }
.zen-rt-table td { font-variant-numeric:tabular-nums; font-size:13px; overflow-wrap:anywhere; }
.zen-unmatched-panel { display:grid; gap:12px; }
.zen-unmatched-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; }
.zen-unmatched-head-actions { display:flex; flex-wrap:wrap; gap:8px; }
.zen-unmatched-bar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:12px 14px; border:1px solid var(--zt-line); border-radius:var(--radius-micro,14px); background:var(--zt-panel); }
.zen-unmatched-checkall { display:inline-flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; }
.zen-unmatched-bar .zen-picker, .zen-unmatched-bar select { flex:1 1 200px; min-width:0; }
.zen-unmatched-table th:first-child, .zen-unmatched-table td:first-child { width:34px; max-width:34px; text-align:center!important; padding-left:4px; padding-right:4px; }
.zen-unmatched-table th:nth-child(2), .zen-unmatched-table td:nth-child(2) { text-align:left!important; white-space:normal; overflow-wrap:anywhere; max-width:22rem; }
.zen-unmatched-domain { display:grid; gap:4px; min-width:0; }
.zen-unmatched-domain strong { font-size:13px; overflow-wrap:anywhere; }
.zen-unmatched-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:11px; color:var(--zt-muted); }
.zen-unmatched-badge { display:inline-flex; align-items:center; padding:1px 6px; border-radius:6px; background:var(--zt-nested); border:1px solid var(--zt-line); color:var(--zt-muted); font-size:11px; }
.zen-unmatched-scope { min-height:24px!important; padding:2px 8px; border:1px solid var(--zt-line); border-radius:6px!important; background:var(--zt-panel); color:var(--zt-text); font-size:11px!important; cursor:pointer; text-align:left; }
.zen-unmatched-scope[aria-pressed="true"] { border-color:var(--accent,#2563eb); color:var(--accent-strong,#1d4ed8); background:var(--accent-soft,#eff6ff); }
.zen-custom-rules { border-top:1px solid var(--zt-line); padding-top:10px; font-size:13px; }
.zen-custom-rules summary { cursor:pointer; font-weight:500; padding:4px 0; }
.zen-custom-rules-list { display:grid; gap:8px; margin-top:10px; }
.zen-custom-rule-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; border:1px solid var(--zt-line); border-radius:10px; background:var(--zt-panel); }
.zen-custom-rule-row button { min-height:32px!important; padding:4px 10px; }
.zen-app-toolbar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
.zen-app-toolbar .zen-app-filter { margin-bottom:0; }
.zen-app-compact-toggle { min-height:32px!important; padding:4px 10px; border:1px solid var(--zt-line); border-radius:8px!important; background:var(--zt-panel); color:var(--zt-muted); font-size:12px!important; cursor:pointer; }
.zen-app-compact-toggle:hover { color:var(--zt-text); border-color:var(--accent,#2563eb); }
.zen-app-usage-table th, .zen-app-usage-table td { padding:7px 8px; }
.zen-app-row-head { display:flex; flex-wrap:wrap; align-items:center; gap:4px 6px; min-width:0; }
.zen-app-pct { font-size:11px; color:var(--zt-muted); font-variant-numeric:tabular-nums; }
.zen-app-bar { height:3px; max-width:180px; margin-top:5px; border-radius:999px; background:var(--progress-track,#eef1f6); overflow:hidden; }
.zen-app-bar>i { display:block; height:100%; border-radius:999px; background:var(--accent,#2563eb); opacity:.78; }
.zen-app-tail-btn { width:100%; min-height:36px!important; padding:6px 10px; border:1px solid var(--zt-line); border-radius:9px!important; background:var(--zt-panel); color:var(--zt-muted); font-size:12px!important; text-align:center; cursor:pointer; }
.zen-app-tail-btn:hover { color:var(--accent-strong,#1d4ed8); border-color:var(--accent,#2563eb); }
@media (max-width: 900px) { .zen-traffic-page .zen-tf-summary { grid-template-columns:repeat(2,minmax(0,1fr)); } .zen-tf-table th:first-child { width:26%; } .zen-tf-table td { padding-left:8px; padding-right:8px; } }
@media (max-width: 767px) {
.zen-app-tail-btn, .zen-app-compact-toggle { min-height: 40px!important; }
}
@media (max-width: 599px) {
.zen-traffic-page button, .zen-traffic-page select, .zen-traffic-page input { min-height:44px; }
.zen-traffic-page .zen-tf-expand { width:44px; min-width:44px; }
.zen-traffic-page>h2 { font-size:22px; }
.zen-traffic-page>.cbi-map-descr { margin-bottom:16px; }
.zen-traffic-page>.cbi-section, .zen-traffic-page>[role="tabpanel"]>.cbi-section { padding:16px; border-radius:var(--radius-card,20px); margin-bottom:14px; }
.zen-traffic-page .zen-tf-summary { padding:0; gap:10px; }
.zen-tf-sum-item { padding:14px; border-radius:var(--radius-micro,14px); }
.zen-tf-sum-label { font-size:11px; margin-bottom:6px; }
.zen-tf-sum-value { font-size:20px; }
.zen-traffic-page .zen-tf-list { background:transparent; border:0; box-shadow:none; padding:0; }
.zen-tf-list-head { margin:4px 2px 12px; }
.zen-tf-table { display:block; border:0; }
.zen-tf-table thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.zen-tf-table tbody { display:block; }
.zen-tf-table .zen-tf-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-areas:'name action' 'conn conn' 'up down'; gap:0 16px; background:var(--zt-panel); border:1px solid var(--zt-line); border-radius:var(--radius-card,20px); padding:16px; margin-bottom:12px; }
.zen-tf-row td { padding:0; border:0; background:transparent!important; white-space:normal; text-align:left!important; }
.zen-tf-row .zen-tf-name { grid-area:name; grid-column:1/-1; min-width:0; align-self:center; padding-right:56px; }
.zen-tf-row .zen-tf-action { grid-area:action; justify-self:end; }
.zen-tf-row .zen-tf-conn { grid-area:conn; padding:10px 0 14px; }
.zen-tf-row .zen-tf-down { grid-area:down; }
.zen-tf-row .zen-tf-up { grid-area:up; }
.zen-tf-row .zen-tf-today { grid-area:today; display:flex; align-items:center; justify-content:space-between; gap:12px; border-top:1px solid var(--zt-line); padding-top:12px; margin-top:14px; }
.zen-tf-mobile-label { display:block; color:var(--zt-muted); font-size:11px; margin-bottom:4px; }
.zen-tf-today .zen-tf-mobile-label { margin:0; }
.zen-tf-down .zen-tf-number, .zen-tf-up .zen-tf-number { font-size:20px; font-weight:650; letter-spacing:-.025em; }
.zen-tf-table .zen-tf-device-name { font-size:15px; }
.zen-tf-row.zen-tf-expanded { border-radius:var(--radius-card,20px) var(--radius-card,20px) 0 0; margin-bottom:0; }
.zen-tf-table .zen-tf-detail-row { display:block; background:var(--zt-panel); border:1px solid var(--zt-line); border-top:0; border-radius:0 0 var(--radius-card,20px) var(--radius-card,20px); margin-bottom:12px; padding:0 16px 16px; }
.zen-tf-detail-row td { display:block; padding:0; border:0; }
.zen-tf-detail { padding:14px; border-radius:var(--radius-micro,14px); }
.zen-tf-detail-stats { grid-template-columns:1fr; gap:12px; }
.zen-tf-detail-stats>div { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:0 10px; }
.zen-tf-detail-stats strong { grid-row:span 2; align-self:center; margin:0; }
.zen-tf-detail-stats span { text-align:right; font-size:13px; }
.zen-tf-detail-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
.zen-tf-detail-actions button { padding:8px; min-width:0; }
.zen-traffic-page .zen-tf-controls { align-items:stretch; }
.zen-traffic-page .zen-tf-controls>label { width:100%; font-size:12px; }
.zen-traffic-page .zen-tf-controls>select { width:100%; }
.zen-tf-tabs { display:grid!important; grid-template-columns:repeat(2,minmax(0,1fr)); width:100%; }
.zen-tf-tabs button { white-space:normal; font-size:12px; min-height:40px; }
.zen-traffic-page .zen-rt-summary { gap:10px; }
.zen-rt-summary>div { padding:14px; }
.zen-traffic-page .zen-rt-summary strong { font-size:20px; }
.zen-traffic-page .zen-rt-field { flex-basis:100%; }
.zen-traffic-page .zen-rt-controls>button { width:100%; }
.zen-traffic-page .zen-rt-legend { justify-content:flex-start; font-size:12px; }
.zen-traffic-page .zen-rt-pagination { justify-content:space-between; gap:8px; }
.zen-traffic-page .zen-rt-table td, .zen-traffic-page .zen-rt-table th { font-size:11px; padding:10px 6px; }
}
@media (prefers-color-scheme: dark) {
  html:not([data-theme]):not([data-darkmode]) .zen-traffic-page {
    --zt-panel:var(--bg-panel,#1b1e24); --zt-nested:var(--bg-nested,#232730); --zt-text:var(--text,#f3f3f5); --zt-muted:var(--text-secondary,#b2b2bc); --zt-line:var(--line,#2e3340);
  }
}
`;
		document.head.appendChild(style);
	}
});
