// 只接收已核实的历史办理快照；取数、岗位权限及实际批次生成由接入层负责。
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import {layouts as kinds} from './layouts.mjs?v=13';
const humanTime = value => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) {
    return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(value));
  }
  return value;
};
const required = (v, label) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少${label}，不能猜测打印。`);
  return v;
};
const actualTime = (v, label) => {
  required(v, label);
  // 接入层将源表毫秒时间转换成带时区的ISO时间，禁止用打印时间补业务时间。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) {
    throw new Error(`${label}须来自已核实的带时区时间，不能猜测打印。`);
  }
  return v;
};

// 同申请的分次办理分开；没有实际交接批次的历史行各自一张，禁止拿申请版本键猜合单。
export function groupActualRows(rows) {
  const groups = new Map(), seen = new Set();
  for (const row of rows) {
    required(row.recordId, '来源记录');
    if (seen.has(row.recordId)) throw new Error('来源记录重复，请核对取数，不能重复打印计数。');
    seen.add(row.recordId);
    required(row.requestId, '来源申请或仓管办理来源');
    if (!kinds[row.kind]) throw new Error('该办理类型不是已配置的实际交接记录。');
    if (row.state !== 'completed') throw new Error('未结束的办理、预留或取消不能冒充实际交接记录。');
    required(row.name, '物品名'); required(row.handler, '实际经办人'); actualTime(row.time, '实际办理时间');
    // 历史记录没有耗材单位时只列本项数量，不猜成“件”或合计不同物品。
    if (typeof row.unit !== 'string') throw new Error('数量单位数据不完整。');
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 0) throw new Error('实际数量必须是非负整数。');
    if (row.kind === '出库失败' && (row.quantity !== 0 || !row.note?.trim())) throw new Error('出库失败须有实际数量0及原因。');
    if (row.kind !== '出库失败' && row.quantity === 0) throw new Error('实际交接数量为0，请核对办理事实。');
    if (row.batchId) {
      required(row.batchId, '实际交接批次');
      if (row.batchSource !== 'verified_handoff') throw new Error('申请版本等旧批次键不能用于实际交接合单。');
    }
    const key = JSON.stringify([row.requestId, row.kind, row.batchId || row.recordId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({...row});
  }
  for (const items of groups.values()) {
    if(items[0].batchId){const ids=items.map(r=>r.recordId).sort();if(items.some(r=>!Array.isArray(r.handoffMemberIds)||JSON.stringify([...r.handoffMemberIds].sort())!==JSON.stringify(ids)))throw new Error('本次交接物品未全部取得，不能打印缺项单据。');}
    else if(items.some(r=>r.time!==items[0].time))throw new Error('历史实际时间不一致。');
    for (const name of ['handler','applicant','agent','department','requestTime','purpose','approver','fromStation','toStation','fromResponsible','toResponsible']) {
      if (items.some(x => (x[name] ?? '') !== (items[0][name] ?? ''))) throw new Error(`同次交接的${name}不一致，请先核对来源。`);
    }
  }
  return [...groups.values()];
}

export function renderActualBatch(items, {printedAt, printer, demo=false, test=false, events=[],notes=[]}={}) {
  if (!items?.length) throw new Error('本次没有可打印物品。');
  const groups = groupActualRows(items);
  if (groups.length !== 1) throw new Error('当前选择跨申请或跨交接批次，请分别打印。');
  actualTime(printedAt, '打印时间');
  const first = groups[0][0], [title,timeLabel,quantityLabel] = kinds[first.kind];
  const heading = first.name + (items.length > 1 ? `等${items.length}项` : '');
  const times=items.map(r=>r.time).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const period=times[0]===times.at(-1)?first.time:`${humanTime(times[0])} 至 ${humanTime(times.at(-1))}`;
  const info = [['申请人',first.applicant],['所属部门',first.department],['申请时间',first.requestTime],['用途',first.purpose],[timeLabel,period],['实际经办人',first.handler],['审核人',first.approver],['代领人',first.agent],['原工位',first.fromStation],['原责任人',first.fromResponsible],['新工位',first.toStation],['新责任人',first.toResponsible]];
  // 共享信息横向排版；长用途独占一行，避免挤压日期及人员。
  const shared = info.filter(([,v]) => v), metaRows = [];
  let pending = null;
  for (const entry of shared) {
    const [key,value] = entry;
    if (key === '用途') {
      if (pending) { metaRows.push([pending]); pending = null; }
      metaRows.push([entry]);
    } else if (pending) { metaRows.push([pending,entry]); pending = null; }
    else pending = entry;
  }
  if (pending) metaRows.push([pending]);
  const cells = metaRows.map(entries => `<tr>${entries.map(([k,v]) => `<th>${escape(k)}</th><td${entries.length===1?' colspan="3"':''}>${escape(humanTime(v))}</td>`).join('')}</tr>`).join('');
  const totals = new Map();
  const blocks = items.map((row,index) => {
    const total = (totals.get(row.unit || `未登记单位：${row.name}`) || 0) + row.quantity;
    if (!Number.isSafeInteger(total)) throw new Error('实际数量汇总超出可精确表示范围。');
    totals.set(row.unit || `未登记单位：${row.name}`, total);
    const details = [[timeLabel,row.time],['实物状况',row.condition],['实际经办人',row.handler]];
    if (row.kind === '实际借出') details.push(['预计归还日期',row.expectedReturn]);
    if (row.note) details.push(['说明',row.note]);
    const identity = [['型号',row.model],['识别信息',row.identity]].filter(([,v])=>v).map(([k,v])=>`<span class="item-identity">${escape(k)}：${escape(v)}</span>`).join('');
    const detailText = details.filter(([,v])=>v).map(([k,v])=>`<span class="item-fact"><span class="fact-label">${escape(k)}：</span>${escape(humanTime(v))}</span>`).join('');
    // 每件固定两条表格行；实际时间、经办人、异常说明仍逐件保留。
    return `<tbody class="item"><tr class="item-main"><td class="item-index" rowspan="2">${index+1}</td><td colspan="3"><strong class="name">${escape(row.name)}</strong>${identity}</td><th class="quantity-label">实际数量</th><td class="quantity">${row.quantity}${escape(row.unit)}</td></tr><tr class="item-detail"><td colspan="5">${detailText}</td></tr></tbody>`;
  }).join('');
  const history = events.map(event => {
    required(event.action,'记录动作'); required(event.actor,'记录实际人'); actualTime(event.time,'记录时间');
    return event;
  }).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const label=demo?'排版演示 · 人员、物品和交接均为合成样例，非业务证据':test||items.some(x=>x.purposeLabel==='测试')?'测试记录 · 虚拟验收，非正式交接凭证':'';
  const totalText=[...totals].map(([unit,q])=>unit.startsWith('未登记单位：')?`${escape(unit.slice('未登记单位：'.length))}：${q}`:`${q}${escape(unit)}`).join('；');
  return `${label?`<p class="demo">${escape(label)}</p>`:''}<header class="document-heading"><h1>${escape(heading)}<small>${escape(title)}</small></h1><p class="print-meta">${printer?`打印人员：${escape(printer)}　`:''}打印时间：${escape(humanTime(printedAt))}</p></header><table class="meta"><colgroup><col style="width:17%"><col style="width:33%"><col style="width:17%"><col style="width:33%"></colgroup><tbody>${cells}</tbody></table><table class="items"><colgroup><col style="width:5%"><col style="width:17%"><col style="width:33%"><col style="width:17%"><col style="width:14%"><col style="width:14%"></colgroup><thead><tr><th colspan="6" class="section-heading">物品及本次实际交接</th></tr></thead>${blocks}<tfoot><tr><th colspan="4">${escape(quantityLabel)}</th><td colspan="2">${totalText}</td></tr></tfoot></table>${history.length?`<table class="events"><colgroup><col style="width:20%"><col style="width:80%"></colgroup><thead><tr><th colspan="2" class="section-heading">审批与办理记录</th></tr></thead><tbody>${history.map(x=>`<tr><th>${escape(x.action)}</th><td><span class="event-actor">${escape(x.actor)}</span><span class="event-result">${escape(x.result)}</span><time>${escape(humanTime(x.time))}</time></td></tr>`).join('')}</tbody></table>`:''}${notes.map(n=>`<p class="foot">${escape(n)}</p>`).join('')}`;
}
