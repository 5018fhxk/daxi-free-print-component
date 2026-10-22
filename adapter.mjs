const str = value => String(value ?? '').trim();
const num = value => { if (Array.isArray(value) && value.length===1) value=value[0]; return Number(value); };
export function timeISO(value) {
  if (typeof value==='number' && value>0) return new Date(value).toISOString();
  if (typeof value==='string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  throw new Error('源记录缺少可核实的实际时间，不能用打印时间代替。');
}
export const applicationInputs=Object.freeze({
  '器械':{tableName:'器械申领入口',fields:[['器械名称','器械名称'],['型号','型号'],['数量','申请数量','number'],['使用开始','使用开始','date'],['预计归还','申请预计归还','date'],['用途','用途'],['使用地点','使用地点'],['备注','备注']]},
  '车辆':{tableName:'车辆申领入口',fields:[['车型','车型'],['车牌','车牌'],['驾驶人','驾驶人'],['用车开始','用车开始','date'],['预计归还','申请预计归还','date'],['用途','用途'],['去向','去向'],['备注','备注']]},
  '印章':{tableName:'印章申领入口',fields:[['印章名称','印章名称'],['预计归还','申请预计归还','date'],['用印文件','用印文件'],['用途','用途'],['备注','备注']]},
  '消耗品':{tableName:'消耗品申领入口',fields:[['物品名称','物品名称'],['型号','型号'],['数量','申请数量','number'],['申领备注','领用用途']]}
});
export const businessActions=Object.freeze(['入库','借出','归还','领用出库','延期','取消未交部分','损坏','损坏报备','丢失','找回入库','异常结案']);
export function optionalNumber(v,label){if(v===null||v===undefined||v==='')return null;const n=num(v);if(!Number.isFinite(n)||n<0)throw new Error(label+'数值未核对。');return n;}
export function actualRow(recordId,cells) {
  const category=str(cells['业务类型']),action=str(cells['办理类型']),status=str(cells['办理状态']);
  const failed=['失败','已退回'].includes(status)&&['借出','领用出库'].includes(action);
  if(status!=='已确认'&&!failed)throw new Error('只打印已完成的实际办理或已记录的出库失败。');
  const kind=failed?'出库失败':({'入库':'实际入库','归还':'归还实收','借出':'实际借出','领用出库':'耗材领用','延期':'延期生效','取消未交部分':'未交取消','损坏':'异常处理','损坏报备':'损坏报备','丢失':'丢失结案','找回入库':'找回入库','异常结案':'异常处理'})[action];
  if(!kind)throw new Error('此类型尚未接通实际记录打印。');
  const handler=str(cells['实际经办人']);if(!handler||/多维表格助手/.test(handler))throw new Error('这条历史记录缺少已核实的实际经办人。');
  const stock=['实际入库','找回入库','归还实收','实际借出','耗材领用'].includes(kind),quantity=failed?0:kind==='未交取消'?optionalNumber(cells['取消数量']??cells['确认数量'],'取消数量'):stock?num(cells['确认数量']):kind==='损坏报备'?optionalNumber(cells['确认数量'],'报备涉及数量'):kind==='丢失结案'&&num(cells['已异常结案数量'])>0?optionalNumber(cells['已异常结案数量'],'结案数量'):null;
  if(stock&&(!Number.isSafeInteger(quantity)||quantity<=0||num(cells['已入账数量'])!==quantity))throw new Error('实际数量与入账数量未核对一致，请仓管先核对。');
  if(kind==='未交取消'&&(!Number.isSafeInteger(quantity)||quantity<1))throw new Error('取消数量未核对。');
  const name=str(cells['办理物品']),requestId=str(cells['关联申请记录ID'])||(kind==='实际入库'?recordId:'');if(!name||!requestId)throw new Error('缺少物品或来源申请，不能猜测打印。');
  const note=[cells['办理说明'],cells['处理意见'],cells['取消说明']].map(str).filter((v,i,a)=>v&&a.indexOf(v)===i).join('；'),result=str(cells['办理结果']),treatment=str(cells['异常处理结论']);
  if(!stock&&!note&&!result&&!treatment)throw new Error('本次异常/变更没有已保存的结果或原因。');
  const handoffCount=stock&&cells['已归入交接单数（后台）']!=null?num(cells['已归入交接单数（后台）']):null,handoffIds=stock?str(cells['实际交接单ID（后台）']).split(',').filter(Boolean):[];
  if(handoffCount!==null&&(!Number.isSafeInteger(handoffCount)||handoffCount<0||handoffCount!==handoffIds.length))throw new Error('交接归属未核对，请刷新。');
  const unit=str(cells['实际单位'])||(category==='车辆'?'辆':category==='印章'?'枚':category==='器械'?'件':'');
  const time=timeISO(action==='归还'?(cells['归还时间']||cells['确认时间']):(stock&&kind!=='实际入库'?cells['实际发生时间']:cells['实际发生时间']||cells['确认时间']));
  const vehicleInfo=[];
  if(category==='车辆')for(const [key,label,unitText]of [['起始里程','交车里程','公里'],['结束里程','还车里程','公里'],['交出油量','交车油量','%'],['归还油量','还车油量','%'],['本次油耗','本次油耗','升/百公里'],['本次油费','油费','元'],['本次过路费','过路费','元'],['本次停车费','停车费','元']]){
    const v=optionalNumber(cells[key],label);if(v===null)continue;if(unitText==='%'&&v>100)throw new Error(label+'超出0至100%，请核对原记录。');vehicleInfo.push([label,String(v)+unitText]);
  }
  const expectedReturn=action==='借出'?cells['原归还期限']:null;
  return {recordId,requestId,name,handler,quantity,kind,category,nonStock:!stock,requestVersion:num(cells['申请提交版本']),state:'completed',unit,purposeLabel:str(cells['数据用途']),time,applicant:str(cells['申请人']),department:str(cells['申请部门']),requestTime:'',condition:str(cells['实物状况']),note,result,treatment,vehicleInfo,photoNames:str(cells['现场照片']),expenseEvidence:str(cells['费用依据']),...(expectedReturn?{expectedReturn:timeISO(expectedReturn)}:{}),...(kind==='延期生效'?{oldReturn:timeISO(cells['原归还期限']),newReturn:timeISO(cells['冻结新归还期限']||cells['申请归还期限'])}:{}),handoffCount,handoffIds};
}

export const sourceConfigs = Object.freeze({
  business:{tableName:'业务办理记录',label:'实际出入库记录',required:['办理物品','办理状态','业务类型','办理类型','实际经办人','确认数量','已入账数量','关联申请记录ID','实际发生时间','确认时间','归还时间'],optional:['申请提交版本','申请人','申请部门','实物状况','办理说明','处理意见','取消说明','取消数量','办理结果','异常处理结论','已异常结案数量','冻结新归还期限','申请归还期限','现场照片','费用依据','起始里程','结束里程','交出油量','归还油量','本次油耗','本次油费','本次过路费','本次停车费','已归入交接单数（后台）','实际交接单ID（后台）','原归还期限','数据用途','实际单位'],raw:['已归入交接单数（后台）','申请提交版本','确认数量','已入账数量','归还时间','确认时间','实际发生时间','原归还期限','取消数量','已异常结案数量','冻结新归还期限','申请归还期限','起始里程','结束里程','交出油量','归还油量','本次油耗','本次油费','本次过路费','本次停车费'],status:'办理状态',completed:'已确认'},
  workstation:{tableName:'工位设备调整',label:'工位回仓与转移记录',required:['物品名称','处理状态','办理事项','设备件数（后台）','实际办理人','实际发生时间','实际提交人（系统）','提交时间（系统）','交接状况（系统）'],optional:['申请人','申请说明','原工位','目标工位','交接说明（系统）','原责任人','审核目标工位（后台）','审核目标责任人（后台）','数据用途','审核人'],raw:['设备件数（后台）','实际发生时间','提交时间（系统）'],status:'处理状态',completed:'已完成'},
  repair:{tableName:'工位设备调整',label:'工位设备检修记录',required:['物品名称','处理状态','办理事项','设备件数（后台）','检修状态（后台）','实际检修结论（系统）','检修办理人','检修时间','实际检修说明（系统）','实际提交人（系统）','提交时间（系统）'],optional:['申请人','申请说明','原工位','交接状况（系统）','数据用途'],raw:['设备件数（后台）','检修时间','提交时间（系统）'],status:'检修状态（后台）',completed:'已完成'}
});
function stationFacts(recordId,cells){
  if(str(cells['处理状态'])!=='已完成')throw new Error('只打印已完成的工位实际交接。');
  const name=str(cells['物品名称']),quantity=num(cells['设备件数（后台）']);
  if(!name||quantity!==1)throw new Error('此工位记录不是已核对的一件设备，不能猜测打印。');
  const submitter=str(cells['实际提交人（系统）']);
  if(!submitter||/多维表格助手/.test(submitter))throw new Error('工位申请缺少真实按钮提交人，不能把草稿创建人当申请提交人。');
  const requestTime=timeISO(cells['提交时间（系统）']);
  return {recordId,requestId:recordId,name,quantity,unit:'件',state:'completed',purposeLabel:str(cells['数据用途']),applicant:str(cells['申请人']),requestTime,submitter,purpose:str(cells['申请说明']),fromStation:str(cells['原工位']),fromResponsible:str(cells['原责任人'])};
}
export function workstationRow(recordId,cells){
  const row=stationFacts(recordId,cells),action=str(cells['办理事项']);
  const kind=action==='回仓'?'工位回仓':action==='转工位'?'工位转移':null;
  if(!kind)throw new Error('工位办理事项尚未核对。');
  const handler=str(cells['实际办理人']);
  if(!handler||/多维表格助手/.test(handler))throw new Error('工位交接缺少真实办理人。');
  if(!['完好','损坏','缺件','待检查'].includes(str(cells['交接状况（系统）'])))throw new Error('工位交接缺少已冻结的实际验收状况。');
  const toStation=kind==='工位转移'?str(cells['审核目标工位（后台）']):'';
  const toResponsible=kind==='工位转移'?str(cells['审核目标责任人（后台）']):'';
  if(kind==='工位转移'&&!toStation)throw new Error('工位转移缺少实际目标工位。');
  const approver=str(cells['审核人']);if(!approver||/多维表格助手/.test(approver))throw new Error('工位记录缺少已保存的实际审核人。');
  return {...row,kind,handler,approver,time:timeISO(cells['实际发生时间']),toStation,toResponsible,condition:str(cells['交接状况（系统）']),note:str(cells['交接说明（系统）'])};
}
export function repairRow(recordId,cells){
  const row=stationFacts(recordId,cells),result=str(cells['实际检修结论（系统）']),handler=str(cells['检修办理人']),note=str(cells['实际检修说明（系统）']);
  if(str(cells['办理事项'])!=='回仓'||str(cells['检修状态（后台）'])!=='已完成'||!['恢复可用','停用'].includes(result))throw new Error('此记录没有已完成的工位回仓检修结果。');
  if(!handler||/多维表格助手/.test(handler)||!note)throw new Error('检修记录缺少真实经办人或说明。');
  return {...row,kind:'工位检修',handler,time:timeISO(cells['检修时间']),note:result+'：'+note};
}
export function sourceRow(type,recordId,cells){
  if(type==='workstation')return workstationRow(recordId,cells);
  if(type==='repair')return repairRow(recordId,cells);
  if(type==='business')return actualRow(recordId,cells);
  throw new Error('打印记录来源尚未配置。');
}

// 整理人只证明谁合单，每件实际经办人和时间始终来自原办理事实。
export const handoffFields=Object.freeze(['整理状态','操作结果','数据用途','冻结记录ID（后台）','所选记录ID文本（后台）','冻结申请ID（后台）','申请记录ID（后台）','冻结申请版本（后台）','申请版本（后台）','冻结业务类型（后台）','业务类型（后台）','冻结办理类型（后台）','办理类型（后台）','冻结记录数（后台）','所选记录数（后台）','已选记录的交接归属数（后台）','打印前范围校验（后台）','本次实际记录','实际整理人','整理时间']);
export function verifyHandoff(headId,cells,rows){
  if(str(cells['整理状态'])!=='已整理'||str(cells['数据用途'])!=='测试'||str(cells['打印前范围校验（后台）'])!=='通过'||!str(cells['操作结果']).startsWith('交接单已生成，'))throw new Error('本次交接单尚未核对完成。');
  const ids=str(cells['冻结记录ID（后台）']).split(',').filter(Boolean),selected=str(cells['所选记录ID文本（后台）']).split(',').filter(Boolean);
  const equal=(a,b)=>a.length===b.length&&[...a].sort().every((v,i)=>v===[...b].sort()[i]);
  const n=num(cells['冻结记录数（后台）']);
  if(!Number.isSafeInteger(n)||n<1||new Set(ids).size!==n||ids.length!==n||num(cells['所选记录数（后台）'])!==n||num(cells['已选记录的交接归属数（后台）'])!==n||!equal(ids,selected)||!equal(ids,rows.map(r=>r.recordId)))throw new Error('交接单成员不完整或重复，不能漏项打印。');
  const link=cells['本次实际记录'];if(!link?.recordIds||!equal(ids,link.recordIds))throw new Error('已封存成员与当前所选记录不一致。');
  for(const [a,b] of [['冻结申请ID（后台）','申请记录ID（后台）'],['冻结业务类型（后台）','业务类型（后台）'],['冻结办理类型（后台）','办理类型（后台）']])if(str(cells[a])!==str(cells[b]))throw new Error('交接单范围已变化，请搭建人核对。');
  // Formula display formatting (1 / 1.0) must not change an integer version's identity.
  const frozenVersion=num(cells['冻结申请版本（后台）']),selectedVersion=num(cells['申请版本（后台）']);
  if(!Number.isSafeInteger(frozenVersion)||frozenVersion<1||!Number.isSafeInteger(selectedVersion)||selectedVersion!==frozenVersion)throw new Error('交接单申请版本已变化，请搭建人核对。');
  const requestId=str(cells['冻结申请ID（后台）']),version=num(cells['冻结申请版本（后台）']),category=str(cells['冻结业务类型（后台）']),kind=({'借出':'实际借出','归还':'归还实收','领用出库':'耗材领用'})[str(cells['冻结办理类型（后台）'])];
  if(!requestId||!Number.isSafeInteger(version)||version<1||!kind||!str(cells['实际整理人']))throw new Error('交接单缺少核实范围或实际整理人。');timeISO(cells['整理时间']);
  if(rows.some(r=>r.purposeLabel!=='测试'||r.requestId!==requestId||r.requestVersion!==version||r.category!==category||r.kind!==kind||r.handler!==rows[0].handler||r.handoffCount!==1||r.handoffIds?.length!==1||r.handoffIds[0]!==headId))throw new Error('原记录与交接单不符，或已重复归单。');
  return rows.map(r=>({...r,batchId:headId,batchSource:'verified_handoff',handoffMemberIds:[...ids]}));
}

// SDK user IDs are compared only within this Base context; display names are not identity.
export function selectionKey(row){return JSON.stringify([row.requestId,row.requestVersion,row.category,row.kind,row.handlerId]);}
export function verifySelection(rows,userId){
  if(!userId||!rows.length||new Set(rows.map(r=>r.recordId)).size!==rows.length)throw new Error('请勾选本次实际交接的物品，不能重复选择。');
  for(const row of rows){
    if(!['实际借出','归还实收','耗材领用'].includes(row.kind)||row.state!=='completed'||row.purposeLabel!=='测试'||row.handlerId!==userId||row.handoffCount!==0||!Number.isSafeInteger(row.requestVersion)||row.requestVersion<1||!Number.isSafeInteger(row.quantity)||row.quantity<1||!row.name||!row.requestId||!Number.isFinite(Date.parse(row.time)))throw new Error('所选记录已变化、已归单，或不是本人已办理的测试记录，请刷新后核对。');
    if(selectionKey(row)!==selectionKey(rows[0]))throw new Error('同一张交接单需来自同一申请、同一版本、同一类办理；其他交接请另建一张。');
  }
  return rows;
}
export function selectionSnapshot(row){return JSON.stringify([row.recordId,selectionKey(row),row.name,row.quantity,row.time,row.handler,row.applicant,row.condition,row.note]);}
export function sameMembers(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&new Set(a).size===a.length&&[...a].sort().every((id,i)=>id===[...b].sort()[i]);}
