/*SCALE-PATCH*/
const ADMS={page:1,q:'',limit:50,total:0,pages:1,last:null};

/* ดึงรายการแบบแบ่งหน้าจาก server (อ่านจำนวนรวมจาก header X-Total-Count) */
async function pg(url,q){
  const p=new URLSearchParams((q||'').replace(/^\?/,''));
  p.set('page',ADMS.page); p.set('limit',ADMS.limit);
  if(ADMS.q) p.set('q',ADMS.q);
  const r=await fetch(url+'?'+p);
  ADMS.total=+r.headers.get('X-Total-Count')||0;
  ADMS.pages=+r.headers.get('X-Total-Pages')||1;
  return r.json();
}

(()=>{
const bar=document.createElement('div');
bar.className='card';
bar.style.cssText='display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0';
bar.innerHTML='<input id="sq" placeholder="ค้นหา ชื่อ / เบอร์ / ที่อยู่ …" style="flex:1;min-width:170px">'+
  '<button class="btn sm ghost" id="pv">◀</button><span id="pi" style="font-size:13px;white-space:nowrap"></span>'+
  '<button class="btn sm ghost" id="nx">▶</button>'+
  '<select id="pl"><option>25</option><option selected>50</option><option>100</option><option>200</option></select>';
$('#list').before(bar);

let t;
$('#sq').oninput=e=>{clearTimeout(t);t=setTimeout(()=>{ADMS.q=e.target.value.trim();ADMS.page=1;render()},400)};
$('#pv').onclick=()=>{if(ADMS.page>1){ADMS.page--;render()}};
$('#nx').onclick=()=>{if(ADMS.page<ADMS.pages){ADMS.page++;render()}};
$('#pl').onchange=e=>{ADMS.limit=+e.target.value;ADMS.page=1;render()};

const _render=render;
render=async function(){
  if(tab!==ADMS.last){ADMS.last=tab;ADMS.page=1;ADMS.q='';$('#sq').value=''}   // เปลี่ยนแท็บ → เริ่มหน้า 1
  bar.style.display=tab==='ar'?'none':'flex';
  await _render();
  $('#pi').textContent='หน้า '+ADMS.page+'/'+ADMS.pages+' • ทั้งหมด '+ADMS.total.toLocaleString('th-TH')+' รายการ';
  document.querySelectorAll('#list img').forEach(i=>i.loading='lazy');          // ไม่โหลดรูปนอกจอ
};
})();
