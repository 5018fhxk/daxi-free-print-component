// Only verified source facts enter this renderer; no application quantity is counted as stock.
import {layouts as kinds} from './layouts.mjs?v=23';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stockKinds=['实际入库','实际借出','归还实收','耗材领用','工位回仓','工位转移','工位检修'];
const humanTime=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(v)):v;
const required=(v,label)=>{if(typeof v!=='string'||!v.trim())throw new Error('缺少'+label+'，不能猜测打印。');return v;};
const actualTime=(v,label)=>{required(v,label);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))throw new Error(label+'须来自已保存的实际时间。');return v;};
export function groupActualRows(rows){
 const groups=new Map(),seen=new Set();
 for(const row of rows){
  required(row.recordId,'来源记录');if(seen.has(row.recordId))throw new Error('来源记录重复。');seen.add(row.recordId);required(row.requestId,'办理来源');
  if(!kinds[row.kind]||row.state!=='completed')throw new Error('未完成或不适用的办理不能打印成已办。');
  required(row.name,'物品名');required(row.handler,'实际经办人');actualTime(row.time,'实际办理时间');if(typeof row.unit!=='string')throw new Error('数量单位不完整。');
  if(row.quantity!==null&&(!Number.isSafeInteger(row.quantity)||row.quantity<0))throw new Error('涉及数量未核对。');
  if(stockKinds.includes(row.kind)&&!(row.quantity>0))throw new Error('实际交接数量须为正整数。');
  if(row.kind==='出库失败'&&(row.quantity!==0||!(row.note||row.result)?.trim()))throw new Error('出库失败须保留数量0及原因。');
  if(row.kind==='未交取消'&&!(row.quantity>0))throw new Error('取消数量未保存。');
  if(row.batchId){required(row.batchId,'本次交接批次');if(row.batchSource!=='verified_handoff')throw new Error('不能按申请版本猜合单。');}
  const key=JSON.stringify([row.category||'',row.requestId,row.kind,row.batchId||row.recordId]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...row});
 }
 for(const items of groups.values()){
  if(items[0].batchId){const ids=items.map(r=>r.recordId).sort();if(items.some(r=>!Array.isArray(r.handoffMemberIds)||JSON.stringify([...r.handoffMemberIds].sort())!==JSON.stringify(ids)))throw new Error('本次交接物品未全部取得。');}
  for(const key of ['handler','applicant','agent','department','requestTime','purpose','approver','fromStation','toStation','fromResponsible','toResponsible'])if(items.some(r=>(r[key]??'')!==(items[0][key]??'')))throw new Error('同次交接的'+key+'不一致。');
  if(items.some(r=>JSON.stringify(r.applicationInfo||[])!==JSON.stringify(items[0].applicationInfo||[])))throw new Error('同次交接的申请内容不一致。');
 }
 return [...groups.values()];
}
export function renderActualBatch(items,{printedAt,printer,demo=false,test=false,notes=[]}={}){
 if(!items?.length)throw new Error('本次没有可打印记录。');const groups=groupActualRows(items);if(groups.length!==1)throw new Error('请按同一类别、同一申请、同次交接分别打印。');actualTime(printedAt,'打印时间');
 const first=items[0],[genericTitle,timeLabel,quantityLabel]=kinds[first.kind],title=['实际借出','归还实收','实际入库'].includes(first.kind)?(first.category||'物品')+genericTitle:first.kind==='耗材领用'?'消耗品领用表':genericTitle;
 const heading=first.name+(items.length>1?`等${items.length}项`:'');
 const application=first.applicationInfo||[],has=(label)=>application.some(([k])=>k===label);
 const info=[['申请人',first.applicant],['所属部门',first.department],['申请时间',first.requestTime],...application,...(!has('用途')&&!has('领用用途')?[['用途',first.purpose]]:[]),['代领人',first.agent],['原工位',first.fromStation],['原责任人',first.fromResponsible],['新工位',first.toStation],['新责任人',first.toResponsible],['原归还期限',first.oldReturn],['生效归还期限',first.newReturn]].filter(([,v])=>v!==null&&v!==undefined&&v!=='');
 const metaRows=[];let pending=null;for(const entry of info){if(['用途','备注','领用用途','申请说明'].includes(entry[0])||String(entry[1]).length>42||String(entry[1]).includes('\n')){if(pending){metaRows.push([pending]);pending=null;}metaRows.push([entry]);}else if(pending){metaRows.push([pending,entry]);pending=null;}else pending=entry;}if(pending)metaRows.push([pending]);
 const cells=metaRows.map(entries=>`<tr${entries.some(([,v])=>String(v).length>160)?' class="meta-long"':''}>${entries.map(([k,v])=>`<th>${escape(k)}</th><td class="field-value"${entries.length===1?' colspan="3"':''}>${escape(humanTime(v))}</td>`).join('')}</tr>`).join('');
 const totals=new Map();let hasQuantity=false;
 const blocks=items.map((row,index)=>{
  if(row.quantity!==null){const unit=row.unit||`未登记单位：${row.name}`,n=(totals.get(unit)||0)+row.quantity;if(!Number.isSafeInteger(n))throw new Error('数量超出精确范围。');totals.set(unit,n);hasQuantity=true;}
  const details=[[timeLabel,row.time],['实物状况',row.condition],['实际经办人',row.handler]];
  if(row.kind==='实际借出')details.push(['交接时预计归还',row.expectedReturn]);
  details.push(...(row.vehicleInfo||[]),['办理说明',row.note],['处理结论',row.treatment],['办理结果',row.result],['现场照片',row.photoNames],['费用依据',row.expenseEvidence]);
  const text=details.filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([k,v])=>`<span class="item-fact"><span class="fact-label">${escape(k)}：</span>${escape(humanTime(v))}</span>`).join('');
  const identity=[['型号',row.model],['识别信息',row.identity]].filter(([,v])=>v).map(([k,v])=>`<span class="item-identity">${escape(k)}：${escape(v)}</span>`).join('');
  const qtyLabel=row.kind==='未交取消'?'取消数量':stockKinds.includes(row.kind)||row.kind==='出库失败'?'实际数量':'涉及数量';
  const qty=row.quantity===null?'未单独记录':String(row.quantity)+escape(row.unit||'（单位未登记）');
  return `<tbody class="item"><tr class="item-main"><td class="item-index" rowspan="2">${index+1}</td><td colspan="3"><strong class="name">${escape(row.name)}</strong>${identity}</td><th class="quantity-label">${qtyLabel}</th><td class="quantity">${qty}</td></tr><tr class="item-detail"><td colspan="5">${text}</td></tr></tbody>`;
 }).join('');
 const totalText=hasQuantity?[...totals].map(([u,q])=>u.startsWith('未登记单位：')?`${escape(u.slice(6))}：${q}（单位未登记）`:`${q}${escape(u)}`).join('；'):'本记录不计重复出入库数量';
 // Only actual warehouse handling facts remain; never fetch or render the multilevel approval history.
 const wh=new Map();for(const row of items){const key=JSON.stringify([row.handler,row.kind]);if(!wh.has(key))wh.set(key,[]);wh.get(key).push(row.time);}
 const history=[...(first.approver?[`<tr><th>仓管审核</th><td><strong>${escape(first.approver)}</strong>　已审核</td></tr>`]:[]),...[...wh].map(([key,times])=>{const [actor,kind]=JSON.parse(key);times.sort((a,b)=>Date.parse(a)-Date.parse(b));const period=times[0]===times.at(-1)?humanTime(times[0]):humanTime(times[0])+' 至 '+humanTime(times.at(-1));return `<tr><th>${escape(kind)}</th><td><strong>${escape(actor)}</strong>　${escape(period)}</td></tr>`;})].join('');
 const label=demo?'排版演示 · 合成样例，非业务证据':test||items.some(r=>r.purposeLabel==='测试')?'测试记录 · 虚拟验收，非正式交接凭证':'';
 const warnings=[...new Set([...notes,...items.flatMap(r=>r.applicationNotes||[])])];
 return `${label?`<p class="demo">${label}</p>`:''}<header class="document-heading"><h1>${escape(heading)}<small>${escape(title)}</small></h1><p class="print-meta">${printer?'打印人员：'+escape(printer)+'　':''}打印时间：${escape(humanTime(printedAt))}</p></header><table class="meta"><colgroup><col style="width:17%"><col style="width:33%"><col style="width:17%"><col style="width:33%"></colgroup><tbody>${cells}</tbody></table><table class="items"><colgroup><col style="width:5%"><col style="width:17%"><col style="width:33%"><col style="width:17%"><col style="width:14%"><col style="width:14%"></colgroup><thead><tr><th colspan="6" class="section-heading">${stockKinds.includes(first.kind)?'物品及本次实际交接':'物品及本次处理结果'}</th></tr></thead>${blocks}<tfoot><tr><th colspan="4">${escape(quantityLabel)}</th><td colspan="2">${totalText}</td></tr></tfoot></table><table class="events"><thead><tr><th colspan="2" class="section-heading">仓管审核及实际办理记录</th></tr></thead><tbody>${history}</tbody></table>${warnings.map(n=>`<p class="foot">${escape(n)}</p>`).join('')}`;
}
