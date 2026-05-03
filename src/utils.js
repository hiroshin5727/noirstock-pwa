export const uid=(p='id')=>`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
export const todayISO=()=>new Date().toISOString().slice(0,10);
export const nowISO=()=>new Date().toISOString();
export const yen=v=>`¥${Math.round(Number(v||0)).toLocaleString('ja-JP')}`;
export const pct=v=>`${(Number(v||0)).toFixed(1)}%`;
export function num(v){if(v==null||v==='')return 0;if(typeof v==='number')return Number.isFinite(v)?v:0;const s=String(v).replace(/[￥¥,円\s]/g,'').replace(/[０-９]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xFEE0));const n=Number(s);return Number.isFinite(n)?n:0}
export function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
export const deepClone=o=>JSON.parse(JSON.stringify(o));
export const normalizeDate=v=>{if(!v)return'';if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}/.test(v))return v.slice(0,10);const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10)};
export const inYear=(date,year)=>!!date&&String(date).slice(0,4)===String(year);
export function downloadText(filename,text,type='application/json'){const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)}
export function readFileAsText(file){return new Promise((res,rej)=>{const r=new FileReader();r.onerror=()=>rej(r.error);r.onload=()=>res(String(r.result||''));r.readAsText(file)})}
export const csvEscape=v=>/[",\n]/.test(String(v??''))?`"${String(v??'').replace(/"/g,'""')}"`:String(v??'');
export function makeCSV(headers,rows){return [headers.map(csvEscape).join(','),...rows.map(row=>headers.map(h=>csvEscape(row[h])).join(','))].join('\n')}
