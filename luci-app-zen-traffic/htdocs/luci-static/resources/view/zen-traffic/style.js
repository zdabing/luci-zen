'use strict';
'require baseclass';

/* Shared app surfaces follow Zen tokens, with fallbacks when another theme is used. */
return baseclass.extend({
	inject() {
		if (document.getElementById('zen-traffic-page-css')) return;
		const style = E('style', { id: 'zen-traffic-page-css' });
		style.textContent = `
.zen-traffic-page{--zt-panel:var(--bg-panel,#fff);--zt-nested:var(--bg-nested,#f1f1f1);--zt-text:var(--text,#171717);--zt-muted:var(--text-secondary,#525252);--zt-line:var(--line,#e5e5e5);--zt-dl:var(--dl,#15803d);--zt-ul:var(--ul,#ea580c);color:var(--zt-text);font-family:var(--font,system-ui,sans-serif);min-width:0}
.zen-traffic-page>h2{font-size:26px;font-weight:650;letter-spacing:-.025em;border:0;padding:0;margin:0 0 10px}
.zen-traffic-page>.cbi-map-descr{color:var(--zt-muted);font-size:13px;line-height:1.65;margin:0 0 24px;max-width:80ch}
.zen-traffic-page>.cbi-section{background:var(--zt-panel);border:0;border-radius:var(--radius,24px);padding:24px;margin:0 0 20px;min-width:0;box-shadow:none}
.zen-traffic-page button{min-height:40px;border-radius:12px;font-size:13px;box-shadow:none}
.zen-traffic-page button:focus-visible,.zen-traffic-page select:focus-visible{outline:2px solid var(--accent,#171717);outline-offset:3px}
.zen-traffic-page select,.zen-traffic-page input{min-height:40px;min-width:0;max-width:100%;border-radius:12px;font-size:13px}
.zen-traffic-page .zen-tf-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;padding:0;background:transparent}
.zen-tf-sum-item{min-width:0;padding:22px;border-radius:24px;background:var(--zt-nested)}
.zen-tf-sum-label{font-size:12px;color:var(--zt-muted);margin-bottom:10px;line-height:1.5}
.zen-tf-sum-value{font-size:clamp(20px,2.2vw,30px);font-weight:650;letter-spacing:-.025em;font-variant-numeric:tabular-nums;white-space:nowrap}
.zen-tf-dl{color:var(--zt-dl)}.zen-tf-ul{color:var(--zt-ul)}
.zen-tf-status{font-size:13px;color:var(--zt-muted);margin:0 0 14px}.zen-tf-status:empty{display:none}
.zen-tf-list-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}
.zen-tf-list-head h3{font-size:16px;font-weight:650;margin:0;border:0;padding:0}.zen-tf-count{font-size:12px;color:var(--zt-muted)}
.zen-tf-table{width:100%;border-collapse:collapse;table-layout:fixed}
.zen-tf-table th{font-size:12px;color:var(--zt-muted);font-weight:500;background:transparent;padding:10px 12px;text-align:left}
.zen-tf-table td{padding:16px 12px;border-bottom:1px solid var(--zt-line);background:transparent;font-size:13px;vertical-align:middle;min-width:0}
.zen-tf-table th:first-child{width:30%}.zen-tf-table th:last-child{width:56px}
.zen-tf-table .th-right,.zen-tf-table .td-right{text-align:right}
.zen-tf-table .zen-tf-device-name{display:block;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zen-tf-address{display:block;margin-top:5px;font-size:12px;color:var(--zt-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zen-tf-online{display:inline-flex;align-items:center;gap:6px;color:var(--zt-muted);font-size:12px}
.zen-tf-online::before{content:'';width:6px;height:6px;flex:none;border-radius:50%;background:var(--status-online,#16a34a)}
.zen-tf-offline .zen-tf-online::before{background:var(--text-muted,#a3a3a3)}.zen-tf-offline .zen-tf-device-name{color:var(--zt-muted)}
.zen-tf-number{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:550}.zen-tf-mobile-label{display:none}
.zen-traffic-page .zen-tf-expand{width:40px;min-width:40px;padding:0;background:var(--zt-nested);border:0;font-size:19px}
.zen-tf-detail-row td{padding:0 12px 20px}.zen-tf-detail{padding:18px;border-radius:18px;background:var(--zt-nested);font-size:12px}
.zen-tf-detail-identities{color:var(--zt-muted);display:grid;gap:6px;margin-bottom:18px;overflow-wrap:anywhere;line-height:1.6}
.zen-tf-detail-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.zen-tf-detail-stats strong{display:block;font-size:12px;font-weight:500;color:var(--zt-muted);margin-bottom:8px}.zen-tf-detail-stats span{display:block;font-size:14px;font-weight:550;line-height:1.8;font-variant-numeric:tabular-nums}
.zen-tf-detail-last{margin:16px 0;color:var(--zt-muted)}.zen-tf-detail-actions{display:flex;flex-wrap:wrap;gap:8px}
.zen-tf-name-field{display:flex;flex-direction:column;gap:8px;font-size:13px;margin:18px 0}.zen-tf-name-field input{width:100%;min-height:44px}.zen-tf-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.zen-tf-modal-actions button{min-height:44px;border-radius:12px;padding:10px 16px}
.zen-tf-empty{text-align:center;color:var(--zt-muted);padding:32px 16px;font-size:13px}
.zen-traffic-page .zen-tf-controls{gap:12px}.zen-traffic-page .zen-tf-tabs{background:var(--zt-nested);padding:4px;border-radius:14px;gap:4px}
.zen-traffic-page .zen-tf-tabs button{border:0;background:transparent;padding:8px 14px}.zen-traffic-page .zen-tf-tabs .important{background:var(--accent,#171717);color:var(--on-accent,#fff)}
.zen-traffic-page .zen-tf-chart-svg{background:var(--zt-nested);border-radius:18px}.zen-traffic-page .zen-tf-legend{padding-top:16px;gap:20px}
.zen-traffic-page .zen-rt-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:20px}.zen-rt-summary>div{background:var(--zt-nested);padding:18px;border-radius:18px;min-width:0}.zen-rt-summary span{color:var(--zt-muted);font-size:12px;line-height:1.5}.zen-traffic-page .zen-rt-summary strong{margin-top:8px;font-size:26px;letter-spacing:-.025em}
.zen-traffic-page .zen-rt-chart{background:var(--zt-nested);border-radius:18px;padding:12px 0}.zen-traffic-page .zen-rt-field{min-width:0;flex:1 1 150px}
.zen-traffic-page .zen-rt-field[hidden]{display:none}
.zen-traffic-page .zen-rt-field input,.zen-traffic-page .zen-rt-field select{width:100%}.zen-traffic-page .zen-rt-table{width:100%;table-layout:fixed}.zen-rt-table th:first-child{width:42%}.zen-rt-table td{font-variant-numeric:tabular-nums;font-size:13px;overflow-wrap:anywhere}
@media(max-width:900px){.zen-traffic-page .zen-tf-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.zen-tf-table th:first-child{width:26%}.zen-tf-table td{padding-left:8px;padding-right:8px}}
@media(max-width:600px){
.zen-traffic-page button,.zen-traffic-page select,.zen-traffic-page input{min-height:44px}.zen-traffic-page .zen-tf-expand{width:44px;min-width:44px}.zen-traffic-page>h2{font-size:24px}.zen-traffic-page>.cbi-map-descr{margin-bottom:18px}.zen-traffic-page>.cbi-section{padding:18px;border-radius:24px;margin-bottom:16px}
.zen-traffic-page .zen-tf-summary{padding:0;gap:12px}.zen-tf-sum-item{padding:18px 16px;border-radius:22px}.zen-tf-sum-label{font-size:11px;margin-bottom:8px}.zen-tf-sum-value{font-size:22px}
.zen-traffic-page .zen-tf-list{background:transparent;padding:0}.zen-tf-list-head{margin:4px 2px 14px}.zen-tf-table{display:block;border:0}.zen-tf-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.zen-tf-table tbody{display:block}
.zen-tf-table .zen-tf-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:'name action' 'conn conn' 'down up' 'today today';gap:0 16px;background:var(--zt-panel);border-radius:24px;padding:18px;margin-bottom:12px}
.zen-tf-row td{padding:0;border:0;background:transparent!important;white-space:normal;text-align:left!important}.zen-tf-row .zen-tf-name{grid-area:name;grid-column:1/-1;min-width:0;align-self:center;padding-right:56px}.zen-tf-row .zen-tf-action{grid-area:action;justify-self:end}.zen-tf-row .zen-tf-conn{grid-area:conn;padding:10px 0 16px}
.zen-tf-row .zen-tf-down{grid-area:down}.zen-tf-row .zen-tf-up{grid-area:up}.zen-tf-row .zen-tf-today{grid-area:today;display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--zt-line);padding-top:14px;margin-top:16px}
.zen-tf-mobile-label{display:block;color:var(--zt-muted);font-size:11px;margin-bottom:5px}.zen-tf-today .zen-tf-mobile-label{margin:0}.zen-tf-down .zen-tf-number,.zen-tf-up .zen-tf-number{font-size:22px;font-weight:650;letter-spacing:-.025em}.zen-tf-table .zen-tf-device-name{font-size:15px}.zen-tf-row.zen-tf-expanded{border-radius:24px 24px 0 0;margin-bottom:0}
.zen-tf-table .zen-tf-detail-row{display:block;background:var(--zt-panel);border-radius:0 0 24px 24px;margin-bottom:12px;padding:0 18px 18px}.zen-tf-detail-row td{display:block;padding:0;border:0}.zen-tf-detail{padding:16px;border-radius:18px}.zen-tf-detail-stats{grid-template-columns:1fr;gap:14px}.zen-tf-detail-stats>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 10px}.zen-tf-detail-stats strong{grid-row:span 2;align-self:center;margin:0}.zen-tf-detail-stats span{text-align:right;font-size:13px}.zen-tf-detail-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.zen-tf-detail-actions button{padding:8px;min-width:0}
.zen-traffic-page .zen-tf-controls{align-items:stretch}.zen-traffic-page .zen-tf-controls>label{width:100%;font-size:12px}.zen-traffic-page .zen-tf-controls>select{width:100%}.zen-tf-tabs{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}.zen-tf-tabs button{white-space:normal;font-size:12px}
.zen-traffic-page .zen-rt-summary{gap:10px}.zen-rt-summary>div{padding:14px}.zen-traffic-page .zen-rt-summary strong{font-size:20px}.zen-traffic-page .zen-rt-field{flex-basis:100%}.zen-traffic-page .zen-rt-controls>button{width:100%}.zen-traffic-page .zen-rt-legend{justify-content:flex-start;font-size:12px}.zen-traffic-page .zen-rt-pagination{justify-content:space-between;gap:8px}.zen-traffic-page .zen-rt-table td,.zen-traffic-page .zen-rt-table th{font-size:11px;padding:10px 6px}
}
@media(prefers-color-scheme:dark){html:not([data-theme]):not([data-darkmode]) .zen-traffic-page{--zt-panel:var(--bg-panel,#1b1b1b);--zt-nested:var(--bg-nested,#242424);--zt-text:var(--text,#f5f5f5);--zt-muted:var(--text-secondary,#c2c2c2);--zt-line:var(--line,#303030)}}
`;
		document.head.appendChild(style);
	}
});
