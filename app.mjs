import {workspace,dashboard,DashboardState,SourceType,FieldType} from './vendor/sdk.mjs';
import {sourceRow,sourceConfigs,timeISO,handoffFields,verifyHandoff,selectionKey,verifySelection,selectionSnapshot,sameMembers} from './adapter.mjs';
import {groupActualRows,renderActualBatch} from './batch.mjs';
const $=id=>document.getElementById(id);
let epoch=0,groups=[],busy=false,saveBusy=false,selectionLocked=false,selectionBinding=null,candidates=[],selectionUser="";
const selected=new Set();
function conceal(text){$('paper').hidden=true;$('paper').replaceChildren();$('print').disabled=true;$('status').textContent=text;}
function fail(e){conceal(e.message||String(e));}
async function permit(binding,entity,param,type='visible'){if(!await binding.context.base.getPermission({entity,...(param?{param}:{}),type}))throw new Error('当前账号没有查看或打印所需的权限。');}
async function cell(binding,id,name,raw=false){const {table,fields}=binding;const fieldId=fields[name];if(!fieldId)return null;await permit(binding,'Cell',{tableId:table.id,recordId:id,fieldId});return raw?table.getCellValue(fieldId,id):table.getCellString(fieldId,id);}
async function loadRow(binding,id){const {table,fields}=binding;await permit(binding,'Record',{tableId:table.id,recordId:id});const cells={};for(const name of binding.source.required)cells[name]=await cell(binding,id,name,binding.source.raw.includes(name));for(const name of binding.source.optional){const fieldId=fields[name];if(fieldId&&['已归入交接单数（后台）','实际交接单ID（后台）'].includes(name)){cells[name]=await cell(binding,id,name,binding.source.raw.includes(name));continue;}cells[name]=fieldId&&await binding.context.base.getPermission({entity:'Cell',param:{tableId:table.id,recordId:id,fieldId},type:'visible'})?await cell(binding,id,name,binding.source.raw.includes(name)):null;}return sourceRow(binding.sourceType,id,cells);}
async function connect(){const config=await dashboard.getConfig();const saved=config.customConfig;const sourceType=saved?.sourceType||'business',source=sourceConfigs[sourceType];if(!source)throw new Error('打印记录来源尚未配置。');if(!saved?.baseToken||!saved?.tableId)throw new Error('先由搭建人在组件设置中连接办理记录。');await dashboard.getData();const context=await workspace.getBitable(saved.baseToken);if(!context)throw new Error('应用没有授权此数据源。');const table=await context.base.getTableById(saved.tableId);const binding={context,table};await permit(binding,'Base',null,'printable');const meta=await table.getFieldMetaList();const fields=Object.fromEntries(meta.map(f=>[f.name,f.id]));if(source.required.some(n=>!fields[n]))throw new Error('当前表缺少实际办理所需字段。');return {...binding,fields,meta,sourceType,source,approvalTableId:saved.approvalTableId,handoffTableId:saved.handoffTableId,handoffInputTableId:saved.handoffInputTableId,testEnvironment:saved.testEnvironment!==false};}
async function handoffRows(binding,id){
  if(!binding.handoffTableId)throw new Error('此记录已归入交接单，请搭建人重新保存打印组件配置。');
  const table=await binding.context.base.getTableById(binding.handoffTableId),fields=Object.fromEntries((await table.getFieldMetaList()).map(f=>[f.name,f.id]));
  if(handoffFields.some(n=>!fields[n]))throw new Error('交接单核对字段不完整。');
  const head={context:binding.context,table,fields};await permit(head,'Record',{tableId:table.id,recordId:id});const cells={};
  for(const n of handoffFields)cells[n]=await cell(head,id,n,['本次实际记录','整理时间'].includes(n));
  const ids=String(cells['冻结记录ID（后台）']||'').split(',').filter(Boolean);if(!ids.length)throw new Error('交接单尚未封存。');
  const rows=[];for(const rid of ids)rows.push(await loadRow(binding,rid));
  return verifyHandoff(id,cells,rows);
}
async function printableRows(binding,rows){
  const result=[],seen=new Set();let blocked=0;
  for(const row of rows){if(binding.sourceType!=='business'||row.handoffCount===0||row.handoffCount===null){result.push(row);continue;}
    if(row.handoffCount!==1||row.handoffIds?.length!==1){blocked++;continue;}const id=row.handoffIds[0];if(seen.has(id))continue;seen.add(id);
    try{result.push(...await handoffRows(binding,id));}catch(e){blocked++;}
  }return {rows:result,blocked};
}
// Source business "申请时间" is a handling request time, not the original application submit time.
// Read only the exact associated application, and only when its version still matches this handoff.
async function applicationSubmitTime(binding,row){
  if(binding.sourceType!=='business'||!Number.isSafeInteger(row.requestVersion)||row.requestVersion<1)return row;
  try{
    const link=binding.meta.find(f=>f.name===`${row.category}申请`);
    if(!link?.property?.tableId)return row;
    const linked=await cell(binding,row.recordId,link.name,true);
    if(!linked||linked.tableId!==link.property.tableId||linked.recordIds?.length!==1||linked.recordIds[0]!==row.requestId)return row;
    const table=await binding.context.base.getTableById(link.property.tableId);
    await permit(binding,'Record',{tableId:table.id,recordId:row.requestId});
    const fields=Object.fromEntries((await table.getFieldMetaList()).map(f=>[f.name,f.id]));
    if(!fields['申请版本']||!fields['提交时间'])return row;
    const parent={context:binding.context,table,fields};
    const version=await cell(parent,row.requestId,'申请版本',true);
    if(Number(version)!==row.requestVersion)return row;
    const submitted=await cell(parent,row.requestId,'提交时间',true);
    return {...row,requestTime:timeISO(submitted)};
  }catch(e){return row;} // No permission or unavailable history: omit, never invent an application time.
}
async function approvalEvents(binding,row){
  if(binding.sourceType!=='business')return {events:[],notes:[]};
  const unavailable={events:[],notes:['本次审批明细未能完整核对，此页仅列已核实的实际交接。']};
  if(!Number.isSafeInteger(row.requestVersion)||row.requestVersion<1)return unavailable;
  try{
    // Table discovery is performed in the native configuration view. Browsing mode uses its saved ID.
    if(!binding.approvalTableId)return unavailable;
    const table=await binding.context.base.getTableById(binding.approvalTableId);
    const fields=Object.fromEntries((await table.getFieldMetaList()).map(f=>[f.name,f.id]));
    const required=['业务模块','申请记录ID','申请提交版本','节点名称','处理状态','实际审批账户','处理时间'];
    if(required.some(name=>!fields[name]))return unavailable;
    const source={context:binding.context,table,fields};
    // Only this application's version; never read another applicant's approval content.
    const filter={conjunction:'and',conditions:[
      {fieldId:fields['申请记录ID'],operator:'is',value:row.requestId},
      {fieldId:fields['申请提交版本'],operator:'is',value:row.requestVersion}
    ]};
    let token;const ids=[];
    do{
      const page=await table.getRecordIdListByPage({pageSize:200,filter,...(token!==undefined?{pageToken:token}:{})});
      ids.push(...page.recordIds);if(!page.hasMore)break;
      if(page.pageToken===undefined||page.pageToken===token)return unavailable;
      token=page.pageToken;
    }while(true);
    const events=[];
    for(const id of ids){
      await permit(source,'Record',{tableId:table.id,recordId:id});
      if(await cell(source,id,'申请记录ID')!==row.requestId||Number(await cell(source,id,'申请提交版本',true))!==row.requestVersion||await cell(source,id,'业务模块')!==row.category)return unavailable;
      const result=await cell(source,id,'处理状态');
      if(!['通过','退回'].includes(result))continue;
      const actor=await cell(source,id,'实际审批账户');
      if(!actor||/多维表格助手/.test(actor))return unavailable;
      const time=timeISO(await cell(source,id,'处理时间',true));
      if(Date.parse(time)>Date.parse(row.time))return unavailable;
      const node=await cell(source,id,'节点名称');
      let opinion='';
      if(fields['审批意见']&&await source.context.base.getPermission({entity:'Cell',param:{tableId:table.id,recordId:id,fieldId:fields['审批意见']},type:'visible'}))opinion=await cell(source,id,'审批意见');
      events.push({action:node||'审批',actor,time,result:result+(opinion?'；'+opinion:'')});
    }
    return events.length?{events,notes:[]}:unavailable;
  }catch(e){return unavailable;}
}
async function recordIds(table,filter){
  let token;const ids=[];
  do{const page=await table.getRecordIdListByPage({pageSize:200,...(filter?{filter}:{}),...(token!==undefined?{pageToken:token}:{})});ids.push(...page.recordIds);if(!page.hasMore)return ids;if(page.pageToken===undefined||page.pageToken===token)throw new Error('记录分页未完成，请刷新核对。');token=page.pageToken;}while(true);
}
// Bounded parallel reads; all writes remain a single explicit owner click.
async function readPool(ids,reader){let cursor=0,done=0;const values=new Array(ids.length);await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{while(cursor<ids.length){const i=cursor++;values[i]=await reader(ids[i]);done++;if(done%5===0&&!saveBusy)$('status').textContent=`正在核对实际记录 ${done}/${ids.length}…`;}}));return values.filter(Boolean);}
async function rowWithIdentity(binding,id){const row=await loadRow(binding,id);const actor=await cell(binding,id,'实际经办人',true);return {...row,handlerId:Array.isArray(actor)&&actor.length===1?actor[0].id:null};}
async function inputBinding(binding){
  if(!binding.handoffInputTableId||binding.sourceType!=='business'||!binding.testEnvironment)throw new Error('勾选入口尚未配置，仅支持专用测试清单。');
  const tables=await binding.context.base.getTableMetaList(),matches=tables.filter(t=>t.name==='交接物品选择（测试）');
  if(matches.length!==1||matches[0].id!==binding.handoffInputTableId||[binding.table.id,binding.handoffTableId].includes(matches[0].id))throw new Error('交接选择表范围不符，已停止保存。');
  const table=await binding.context.base.getTableById(matches[0].id),meta=await table.getFieldMetaList(),fields=Object.fromEntries(meta.map(f=>[f.name,f.id]));
  if(['本次交接','选本次已办物品','创建人','整理状态'].some(n=>!fields[n])||meta.find(f=>f.name==='选本次已办物品')?.property?.tableId!==binding.table.id)throw new Error('选择清单字段或关联来源不符，已停止保存。');
  for(const [name,type] of [['本次交接',FieldType.Text],['选本次已办物品',FieldType.SingleLink],['创建人',FieldType.CreatedUser],['整理状态',FieldType.SingleSelect]])if(meta.find(f=>f.name===name)?.type!==type)throw new Error('选择清单字段类型不符，已停止保存。');
  const input={context:binding.context,table,fields};
  if(!await input.context.base.getPermission({entity:'Record',param:{tableId:table.id},type:'addable'}))throw new Error('当前账号不能新建交接选择清单，请搭建人检查此新表的权限。');
  for(const name of ['本次交接','选本次已办物品'])if(!await input.context.base.getPermission({entity:'Field',param:{tableId:table.id,fieldId:fields[name]},type:'editable'}))throw new Error('当前账号不能填写交接选择，请检查此新表的字段权限。');
  return input;
}
function selectionStatus(text){$('selection-status').textContent=text;}
function renderSelection(){
  const rows=candidates.filter(r=>selected.has(r.recordId)),key=rows.length?selectionKey(rows[0]):null;
  $('selection-list').replaceChildren();
  for(const row of candidates){const label=document.createElement('label');label.className='choice';const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(row.recordId);check.disabled=selectionLocked||saveBusy||(key!==null&&selectionKey(row)!==key);check.onchange=()=>{if(check.checked)selected.add(row.recordId);else selected.delete(row.recordId);renderSelection();};const content=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('span');name.textContent=row.name;detail.textContent=`${row.kind} · ${row.quantity}${row.unit} · ${new Date(row.time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`;content.append(name,detail);label.append(check,content);$('selection-list').append(label);}
  $('selection-count').textContent=`已选 ${rows.length} 项`; $('save-selection').disabled=selectionLocked||saveBusy||!rows.length;
}
async function prepareSelection(binding,rows,mine){
  $('handoff-selection').hidden=true;selectionBinding=null;candidates=[];selected.clear();
  if(binding.sourceType!=='business'||!binding.handoffInputTableId)return;
  try{await inputBinding(binding);const user=await binding.context.bridge.getBaseUserId();const eligible=[];for(const row of rows){try{verifySelection([row],user);eligible.push(row);}catch(e){}}
    if(mine!==epoch)return;selectionUser=user;selectionBinding=binding;candidates=eligible.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));$('handoff-selection').hidden=false;renderSelection();if(!selectionLocked)selectionStatus(candidates.length?'勾选属于本次交接的物品；分次交接另建一张，保存后回 App 生成交接单。':'目前没有本人已办理、尚未归单的测试物品。');
  }catch(e){if(mine!==epoch)return;$('handoff-selection').hidden=false;renderSelection();selectionStatus(e.message||String(e));}
}
async function ownInputMembers(input,id,user){await permit(input,'Record',{tableId:input.table.id,recordId:id});const creator=await cell(input,id,'创建人',true);if(!Array.isArray(creator)||creator.length!==1||creator[0].id!==user)return null;return {ids:(await cell(input,id,'选本次已办物品',true))?.recordIds,state:await cell(input,id,'整理状态')};}
async function saveSelection(){
  if(saveBusy||selectionLocked||!selectionBinding)return;saveBusy=true;renderSelection();let dispatched=false;
  try{
    selectionStatus('正在核对所选物品，请勿重复保存…');const binding=await connect();if(binding.table.id!==selectionBinding.table.id||binding.handoffInputTableId!==selectionBinding.handoffInputTableId)throw new Error('组件来源已变化，请刷新重新选择。');
    const user=await binding.context.bridge.getBaseUserId();if(user!==selectionUser)throw new Error('当前账号已变化，请刷新重新选择。');
    const original=candidates.filter(r=>selected.has(r.recordId));verifySelection(original,user);const fresh=[];
    for(const row of original){const now=await rowWithIdentity(binding,row.recordId);if(selectionSnapshot(now)!==selectionSnapshot(row))throw new Error('物品、数量、办理时间或说明已变化，请刷新后重新核对。');fresh.push(now);}
    verifySelection(fresh,user);const input=await inputBinding(binding),ids=fresh.map(r=>r.recordId),matches=[];
    // Reuse a matching draft after an uncertain prior response; never update or delete it.
    for(const id of await recordIds(input.table,{conjunction:'and',conditions:[{fieldId:input.fields['创建人'],fieldType:FieldType.CreatedUser,operator:'is',value:[user]}]})){let own;try{own=await ownInputMembers(input,id,user);}catch(e){throw new Error('不能完整核对已有选择清单，请返回 App 核对，暂不保存。');}if(own&&sameMembers(own.ids,ids))matches.push({id,...own});}
    if(matches.length>1)throw new Error('发现多张相同选择清单，请返回 App 核对，暂不另建。');
    let id;if(matches.length){if(matches[0].state!=='草稿')throw new Error('相同选择已进入整理，请返回 App 查看结果，暂不另建。');id=matches[0].id;}
    else{
      // The sole business write: ONLY the new selection helper and exactly two owner-entered fields.
      const fields={
        [input.fields['本次交接']]:[{type:'text',text:`${fresh[0].name}${fresh.length>1?`等${fresh.length}项`:''} · ${fresh[0].kind}`}],
        [input.fields['选本次已办物品']]:{type:'text',text:fresh.map(r=>r.name).join('、'),tableId:binding.table.id,recordIds:ids}
      };
      dispatched=true;id=await input.table.addRecord({fields});
    }
    if(typeof id!=='string'||!id)throw new Error('保存返回未能确认。');const saved=await ownInputMembers(input,id,user);if(!saved||saved.state!=='草稿'||!sameMembers(saved.ids,ids))throw new Error('保存后的物品或创建账号未能核对。');
    selectionLocked=true;selectionStatus(`已保存：${fresh.map(r=>r.name).join('、')}。请回 App 的【整理交接单（测试）】，找到同名清单，点【生成交接单】。本次保存不会出入库。`);
  }catch(e){if(dispatched){selectionLocked=true;selectionStatus('暂不能确认保存结果，请回 App 的【整理交接单（测试）】核对，不要重复保存。'+(e.message||''));}else selectionStatus(e.message||String(e));}
  finally{saveBusy=false;renderSelection();}
}
async function initialize(){if(saveBusy)return;const mine=++epoch;conceal('正在核对可查看的实际记录…');$('records').hidden=true;$('handoff-selection').hidden=true;groups=[];const binding=await connect();if(mine!==epoch)return;const ids=await recordIds(binding.table);if(mine!==epoch)return;
const rows=await readPool(ids,async id=>{if(mine!==epoch)return null;try{await permit(binding,'Record',{tableId:binding.table.id,recordId:id});if(await cell(binding,id,binding.source.status)!==binding.source.completed)return null;if(binding.sourceType==='business'&&!['归还','借出','领用出库'].includes(await cell(binding,id,'办理类型')))return null;return binding.sourceType==='business'?await rowWithIdentity(binding,id):await loadRow(binding,id);}catch(e){return null;}});
if(mine!==epoch)return;await prepareSelection(binding,rows,mine);if(mine!==epoch)return;const printable=await printableRows(binding,rows);if(mine!==epoch)return;groups=groupActualRows(printable.rows).sort((a,b)=>Date.parse(b[0].time)-Date.parse(a[0].time));$('records').replaceChildren();for(const [i,items] of groups.entries()){const option=document.createElement('option');option.value=String(i);option.textContent=`${items[0].name}${items.length>1?`等${items.length}项`:''} · ${items[0].kind} · ${new Date(items[0].time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`;$('records').append(option);}$('reload').hidden=false;if(!groups.length){conceal('当前没有已核实、获准打印的实际记录。');return;}$('records').hidden=false;await preview();if(printable.blocked)$('status').textContent+=' 部分交接单未完整核对，已暂缓列出。';}
async function preview(){const mine=++epoch;conceal('正在重新核对本次记录…');const items=groups[Number($('records').value)];if(!items?.length)throw new Error('请先选择实际记录。');const binding=await connect();if(mine!==epoch)return false;const baseRows=items[0].batchId?await handoffRows(binding,items[0].batchId):[await loadRow(binding,items[0].recordId)];if(!items[0].batchId&&baseRows[0].handoffCount>0)throw new Error('记录已归入交接单，请刷新后选整张单据。');const fresh=[];for(const row of baseRows){fresh.push(await applicationSubmitTime(binding,row));if(mine!==epoch)return false;}const validated=groupActualRows(fresh);if(validated.length!==1||validated[0].length!==items.length)throw new Error('本次记录已变化，请刷新后重新选择。');const approvals=await approvalEvents(binding,[...fresh].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))[0]);await permit(binding,'Base',null,'printable');if(mine!==epoch)return false;$('paper').innerHTML=renderActualBatch(fresh,{printedAt:new Date().toISOString(),test:binding.testEnvironment,...approvals});$('paper').hidden=false;$('print').disabled=false;$('status').textContent=approvals.notes.length?'实际交接已核对，审批明细暂缺；请先查看纸面说明。':'本次实际记录已核对，可打印或保存PDF。';return mine;}
async function setup(){let cursor;do{const list=await workspace.getBaseList(cursor?{page:{cursor}}:{});for(const base of list.base_list){const option=document.createElement('option');option.value=base.token;option.textContent=base.name;$('bases').append(option);}if(!list.page.hasMore)break;if(!list.page.cursor||cursor===list.page.cursor)throw new Error('数据表分页未完成。');cursor=list.page.cursor;}while(true);$('setup').hidden=false;$('status').textContent='选择现有数据表，选择要打印的实际记录类型。';}
$('configure').onclick=async()=>{if(busy)return;busy=true;try{const baseToken=$('bases').value,sourceType=$('source').value,source=sourceConfigs[sourceType];if(!source)throw new Error('请选择记录类型。');const ctx=await workspace.getBitable(baseToken);if(!ctx)throw new Error('此数据表尚未授权给应用。');const tables=await ctx.base.getTableMetaList();const chosen=tables.filter(t=>t.name===source.tableName);if(chosen.length!==1)throw new Error('没有找到唯一的'+source.tableName+'表。');const tbl=await ctx.base.getTableById(chosen[0].id);const field=(await tbl.getFieldMetaList()).find(f=>f.name===(sourceType==='business'?'办理物品':'物品名称'));if(!field)throw new Error('缺少物品名字段。');const approvalTables=sourceType==='business'?tables.filter(t=>t.name==='审批链快照'):[];const approvalTableId=approvalTables.length===1?approvalTables[0].id:undefined;const handoffTables=sourceType==='business'?tables.filter(t=>t.name==='实际交接单（测试）'):[];const handoffTableId=handoffTables.length===1?handoffTables[0].id:undefined;const inputTables=sourceType==='business'?tables.filter(t=>t.name==='交接物品选择（测试）'):[];const handoffInputTableId=inputTables.length===1?inputTables[0].id:undefined;const condition={baseToken,tableId:chosen[0].id,dataRange:{type:SourceType.ALL},groups:[{fieldId:field.id}],series:'COUNTA'};await dashboard.getPreviewData(condition);if(!await dashboard.saveConfig({dataConditions:[condition],customConfig:{baseToken,tableId:chosen[0].id,sourceType,approvalTableId,handoffTableId,handoffInputTableId,version:7,testEnvironment:true}}))throw new Error('配置未保存。');$('status').textContent='已保存，返回浏览页查看实际记录。';}catch(e){fail(e);}finally{busy=false;}};
$('save-selection').onclick=saveSelection;
$('reload').onclick=()=>initialize().catch(fail);$('records').onchange=()=>preview().catch(fail);$('print').onclick=async()=>{if(busy)return;busy=true;try{const current=await preview();await document.fonts.ready;if(current&&current===epoch&&!$('paper').hidden)window.print();}catch(e){fail(e);}finally{busy=false;}};
try{if([DashboardState.Create,DashboardState.Config].includes(dashboard.state))await setup();else await initialize();dashboard.onConfigChange(()=>{if(!saveBusy)initialize().catch(fail);});dashboard.onDataChange(()=>{if(!saveBusy)initialize().catch(fail);});await dashboard.setRendered();}catch(e){fail(e);}
