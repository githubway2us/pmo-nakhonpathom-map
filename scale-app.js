/*SCALE-PATCH*/
(()=>{
const st=document.createElement('style');
st.textContent='.clb{border-radius:50%;background:rgba(31,111,235,.88);color:#fff;text-align:center;font:700 13px system-ui,sans-serif;border:3px solid rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(0,0,0,.3);box-sizing:border-box}';
document.head.appendChild(st);

let vLayer=null,ctl=null,tmr=null,wired=false,mineDone=false;
const nice=n=>n>=1e4?Math.round(n/1e3)+'k':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);
const clIcon=n=>{const s=n>=1e4?60:n>=1e3?52:n>=100?44:n>1?38:26;
  return L.divIcon({className:'',iconSize:[s,s],html:'<div class="clb" style="width:'+s+'px;height:'+s+'px;line-height:'+(s-6)+'px">'+(n>1?nice(n):'')+'</div>'})};
const later=ms=>{clearTimeout(tmr);tmr=setTimeout(()=>loadPoints(),ms)};

function fitFilter(){            // กรองอำเภอ/ตำบล → ซูมไปที่เขตนั้น
  if(!boundary) return false;
  let b=null;
  boundary.eachLayer(l=>{
    const pr=(l.feature&&l.feature.properties)||{};
    const t=stripPrefix(pick(pr,PK)),a=stripPrefix(pick(pr,AK));
    const ok=filt.tambon?(t===filt.tambon&&(!filt.amphoe||a===filt.amphoe)):(a===filt.amphoe);
    if(ok){const lb=l.getBounds();b=b?b.extend(lb):L.latLngBounds(lb.getSouthWest(),lb.getNorthEast())}
  });
  if(b){map.fitBounds(b,{padding:[30,30]});return true}
  return false;
}

/* โหลดเฉพาะสิ่งที่อยู่ในกรอบจอ: ซูมไกล = กลุ่มนับจำนวน (SQL), ซูม ≥16 = หมุดจริง */
loadPoints=async function(fit){
  if(!map) return;
  if(!vLayer) vLayer=L.layerGroup().addTo(map);
  if(!wired){wired=true;map.on('moveend',()=>later(250));setInterval(()=>{if(!document.hidden)loadPoints()},60000)}
  if(!mineDone&&me){mineDone=true;loadMine()}
  if(fit&&(filt.amphoe||filt.tambon)&&fitFilter()) return;   // fitBounds จะทำให้ moveend โหลดต่อเอง

  ctl&&ctl.abort(); ctl=new AbortController();
  const b=map.getBounds().pad(.15);
  const q=new URLSearchParams({zoom:map.getZoom(),bbox:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(',')});
  if(filt.amphoe)q.set('amphoe',filt.amphoe);
  if(filt.tambon)q.set('tambon',filt.tambon);
  let d;
  try{const r=await fetch('/api/points/clusters?'+q,{signal:ctl.signal});if(!r.ok)return;d=await r.json()}
  catch(e){return}

  vLayer.clearLayers(); let total=0;
  if(d.mode==='points'){
    d.items.forEach(i=>{total++;
      vLayer.addLayer(L.marker([i.lat,i.lng],{icon:icon(i.caseType)}).on('click',()=>detail(i.id))
        .bindTooltip(i.caseName,{direction:'top',offset:[0,-28]}));});
  }else{
    d.items.forEach(c=>{total+=c.n;
      const m=L.marker([c.lat,c.lng],{icon:clIcon(c.n)});
      m.on('click',()=>{
        if(c.n===1) return detail(c.id);
        if(c.minLat===c.maxLat&&c.minLng===c.maxLng) return map.setView([c.lat,c.lng],17);
        map.fitBounds([[c.minLat,c.minLng],[c.maxLat,c.maxLng]],{padding:[50,50],maxZoom:17});
      });
      vLayer.addLayer(m);});
  }
  $('#chipCount').textContent='🗺️ '+total.toLocaleString('th-TH')+' จุดในมุมมอง'+(d.mode==='clusters'&&d.count>=1000?'+':'');
};

/* เคสของตัวเองที่ยังไม่อนุมัติ/ถูกปฏิเสธ → แสดงแยก (ลากย้ายได้เหมือนเดิม) */
const _add=addMarkerToMap;
async function loadMine(){
  try{const r=await fetch('/api/points?mine=1&limit=300');if(!r.ok)return;
    (await r.json()).filter(p=>p.status!=='approved').forEach(_add)}catch(e){}
}
addMarkerToMap=function(p){
  if(p.status==='approved'){                       // เคสอนุมัติแล้วให้มาจากชั้น cluster เท่านั้น
    if(markers[p.id]){cluster.removeLayer(markers[p.id]);delete markers[p.id]}
    return later(400);
  }
  _add(p);
};
fetchAndAddMarker=async function(){later(500)};    // มีเคสใหม่อนุมัติ → รีเฟรชมุมมอง ไม่โหลดทีละจุด
})();
