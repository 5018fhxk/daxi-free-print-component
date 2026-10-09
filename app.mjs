import {workspace,dashboard,DashboardState,SourceType} from './vendor/sdk.mjs';
import {sourceRow,sourceConfigs,timeISO} from './adapter.mjs';
import {groupActualRows,renderActualBatch} from './batch.mjs';
const $=id=>document.getElementById(id);
let epoch=0,groups=[],busy=false;
function conceal(text){$('paper').hidden=true;$('paper').replaceChildren();$('print').disabled=true;$('status').textContent=text;}
function fail(e){conceal(e.message||String(e));}
async function permit(binding,entity,param,type='visible'){if(!await binding.context.base.getPermission({entity,...(param?{param}:{}),type}))throw new Error('当前账号没有查看或打印所需的权限。');}
async function cell(binding,id,name,raw=false){const {table,fields}=binding;const fieldId=fields[name];if(!fieldId)return null;await permit(binding,'Cell',{tableId:table.id,recordId:id,fieldId});return raw?table.getCellValue(fieldId,id):table.getCellString(fieldId,id);}
async function loadRow(binding,id){const {table,fields}=binding;await permit(binding,'Record',{tableId:table.id,recordId:id});const cells={};for(const name of binding.source.required)cells[name]=await cell(binding,id,name,binding.source.raw.includes(name));for(const name of binding.source.optional){const fieldId=fields[name];cells[name]=fieldId&&await binding.context.base.getPermission({entity:'Cell',param:{tableId:table.id,recordId:id,fieldId},type:'visible'})?await cell(binding,id,name,binding.source.raw.includes(name)):null;}return sourceRow(binding.sourceType,id,cells);}
async function connect(){const config=await dashboard.getConfig();const saved=config.customConfig;const sourceType=saved?.sourceType||'business',source=sourceConfigs[sourceType];if(!source)throw new Error('打印记录来源尚未配置。');if(!saved?.baseToken||!saved?.tableId)throw new Error('先由搭建人在组件设置中连接办理记录。');await dashboard.getData();const context=await workspace.getBitable(saved.baseToken);if(!context)throw new Error('应用没有授权此数据源。');const table=await context.base.getTableById(saved.tableId);const binding={context,table};await permit(binding,'Base',null,'printable');const meta=await table.getFieldMetaList();const fields=Object.fromEntries(meta.map(f=>[f.name,f.id]));if(source.required.some(n=>!fields[n]))throw new Error('当前表缺少实际办理所需字段。');return {...binding,fields,meta,sourceType,source,approvalTableId:saved.approvalTableId,testEnvironment:saved.testEnvironment!==false};}
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
async function initialize(){const mine=++epoch;conceal('正在核对可查看的实际记录…');$('records').hidden=true;groups=[];const binding=await connect();if(mine!==epoch)return;const {table}=binding;let token,ids=[];do{const page=await table.getRecordIdListByPage({pageSize:200,...(token!==undefined?{pageToken:token}:{})});if(mine!==epoch)return;ids.push(...page.recordIds);if(!page.hasMore)break;if(page.pageToken===undefined||page.pageToken===token)throw new Error('记录分页未完成，请刷新后重试。');token=page.pageToken;}while(true);
const rows=[];for(const id of ids){if(mine!==epoch)return;try{await permit(binding,'Record',{tableId:table.id,recordId:id});if(await cell(binding,id,binding.source.status)!==binding.source.completed)continue;if(binding.sourceType==='business'&&!['归还','借出','领用出库'].includes(await cell(binding,id,'办理类型')))continue;rows.push(await loadRow(binding,id));}catch(e){/* 当前无权或历史事实不足的条目不列为可打印；不记录其内容。 */}}
if(mine!==epoch)return;groups=groupActualRows(rows).sort((a,b)=>Date.parse(b[0].time)-Date.parse(a[0].time));$('records').replaceChildren();for(const [i,items] of groups.entries()){const option=document.createElement('option');option.value=String(i);option.textContent=`${items[0].name}${items.length>1?`等${items.length}项`:''} · ${items[0].kind} · ${new Date(items[0].time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`;$('records').append(option);}$('reload').hidden=false;if(!groups.length){conceal('当前没有已核实、获准打印的实际记录。');return;}$('records').hidden=false;await preview();}
async function preview(){const mine=++epoch;conceal('正在重新核对本次记录…');const items=groups[Number($('records').value)];if(!items?.length)throw new Error('请先选择实际记录。');const binding=await connect();if(mine!==epoch)return false;const fresh=[];for(const old of items){fresh.push(await applicationSubmitTime(binding,await loadRow(binding,old.recordId)));if(mine!==epoch)return false;}const validated=groupActualRows(fresh);if(validated.length!==1||validated[0].length!==items.length)throw new Error('本次记录已变化，请刷新后重新选择。');const approvals=await approvalEvents(binding,fresh[0]);await permit(binding,'Base',null,'printable');if(mine!==epoch)return false;$('paper').innerHTML=renderActualBatch(fresh,{printedAt:new Date().toISOString(),test:binding.testEnvironment,...approvals});$('paper').hidden=false;$('print').disabled=false;$('status').textContent=approvals.notes.length?'实际交接已核对，审批明细暂缺；请先查看纸面说明。':'本次实际记录已核对，可打印或保存PDF。';return mine;}
async function setup(){let cursor;do{const list=await workspace.getBaseList(cursor?{page:{cursor}}:{});for(const base of list.base_list){const option=document.createElement('option');option.value=base.token;option.textContent=base.name;$('bases').append(option);}if(!list.page.hasMore)break;if(!list.page.cursor||cursor===list.page.cursor)throw new Error('数据表分页未完成。');cursor=list.page.cursor;}while(true);$('setup').hidden=false;$('status').textContent='选择现有数据表，选择要打印的实际记录类型。';}
$('configure').onclick=async()=>{if(busy)return;busy=true;try{const baseToken=$('bases').value,sourceType=$('source').value,source=sourceConfigs[sourceType];if(!source)throw new Error('请选择记录类型。');const ctx=await workspace.getBitable(baseToken);if(!ctx)throw new Error('此数据表尚未授权给应用。');const tables=await ctx.base.getTableMetaList();const chosen=tables.filter(t=>t.name===source.tableName);if(chosen.length!==1)throw new Error('没有找到唯一的'+source.tableName+'表。');const tbl=await ctx.base.getTableById(chosen[0].id);const field=(await tbl.getFieldMetaList()).find(f=>f.name===(sourceType==='business'?'办理物品':'物品名称'));if(!field)throw new Error('缺少物品名字段。');const approvalTables=sourceType==='business'?tables.filter(t=>t.name==='审批链快照'):[];const approvalTableId=approvalTables.length===1?approvalTables[0].id:undefined;const condition={baseToken,tableId:chosen[0].id,dataRange:{type:SourceType.ALL},groups:[{fieldId:field.id}],series:'COUNTA'};await dashboard.getPreviewData(condition);if(!await dashboard.saveConfig({dataConditions:[condition],customConfig:{baseToken,tableId:chosen[0].id,sourceType,approvalTableId,version:5,testEnvironment:true}}))throw new Error('配置未保存。');$('status').textContent='已保存，返回浏览页查看实际记录。';}catch(e){fail(e);}finally{busy=false;}};
$('reload').onclick=()=>initialize().catch(fail);$('records').onchange=()=>preview().catch(fail);$('print').onclick=async()=>{if(busy)return;busy=true;try{const current=await preview();await document.fonts.ready;if(current&&current===epoch&&!$('paper').hidden)window.print();}catch(e){fail(e);}finally{busy=false;}};
try{if([DashboardState.Create,DashboardState.Config].includes(dashboard.state))await setup();else await initialize();dashboard.onConfigChange(()=>initialize().catch(fail));dashboard.onDataChange(()=>initialize().catch(fail));await dashboard.setRendered();}catch(e){fail(e);}
