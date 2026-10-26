// Local synthetic UI preview. Never contacts Supabase and never ships in dist.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const mock = String.raw`
export const CONFIGURED=true;
const previewRole=new URLSearchParams(location.search).get('role')==='operador'?'operador':'admin';
const day='2026-10-05';
const store={
 profiles:[{id:'admin',full_name:(previewRole==='admin'?'Administración':'Capturista')+' · prueba local',role:previewRole,active:true}],schema_versions:[{version:2026102101}],
 products_view:[{id:'p1',name:'Agua 600 ml',category:'Bebidas',sell_price:20,cost_price:8,active:true},{id:'p2',name:'Agua 1500 ml',category:'Bebidas',sell_price:30,cost_price:12,active:true}],
 sale_days:[{id:'d1',date:day,sport:'futbol',status:'submitted',day_type:'evento_especial',event_name:'Partido de prueba',event_tags:['futbol'],created_by:'admin',profiles:{full_name:'Prueba local'},tickets:[{amount:100}]}],
 tickets_view:[{id:'t1',sale_day_id:'d1',ts:day+'T18:00:00Z',amount:100,receipt_type:'sale'}],
 ticket_items_view:[{id:'i1',ticket_id:'t1',product_id:'p1',product_name_raw:'Agua 600 ml',qty:5,unit_price:20,unit_cost:8,line_net_amount:100}],
 games:[{id:'g1',sale_day_id:'d1',start_time:'12:00',cars_parked:10,cars_charged:8,parking_rate:30,charges_parking:true,notes:'Prueba'}],
 inventory_counts:[{id:'c1',sale_day_id:'d1',product_id:'p1',physical_count:20,counted_at:day+'T17:00:00Z',count_source:'manual',opening_stock:null,sold:null}],
 day_corrections:[],correction_decisions:[],purchase_plans:[],inventory_movements:[],scheduled_games:[],app_settings:[{id:true,operators_see_all_days:true,operators_see_costs:true}]
};store.products=store.products_view;
for(const [index,date] of ['2026-09-02','2026-09-09','2026-09-16','2026-09-05','2026-09-12','2026-09-19'].entries()){
 const id='sample'+index,qty=index<3?10:100;
 store.sale_days.push({id,date,sport:'futbol',status:'reviewed',day_type:'dia_partido',event_name:'Evento sintético',event_tags:['futbol'],created_by:'admin',profiles:{full_name:'Prueba local'}});
 store.tickets_view.push({id:'t'+id,sale_day_id:id,ts:date+'T18:00:00Z',amount:qty*20,receipt_type:'sale'});
 store.ticket_items_view.push({id:'i'+id,ticket_id:'t'+id,product_id:'p1',product_name_raw:'Agua 600 ml',qty,unit_price:20,unit_cost:8,line_net_amount:qty*20});
 for(let n=0;n<3;n++)store.games.push({id:id+n,sale_day_id:id,start_time:(12+n)+':00',cars_parked:10,cars_charged:8,parking_rate:30,charges_parking:true});
}
store.tickets=store.tickets_view;
class Query{
 constructor(table){this.table=table;this.filters=[];this.start=0;this.end=99999;this.mode='read';}
 select(){return this;}order(){return this;}limit(n){this.end=n-1;return this;}range(a,b){this.start=a;this.end=b;return this;}
 eq(k,v){this.filters.push(r=>r[k]===v);return this;}neq(k,v){this.filters.push(r=>r[k]!==v);return this;}is(k,v){return this.eq(k,v);}in(k,vs){this.filters.push(r=>vs.includes(r[k]));return this;}
 gte(k,v){this.filters.push(r=>r[k]>=v);return this;}lte(k,v){this.filters.push(r=>r[k]<=v);return this;}
 single(){this.one=true;return this;}maybeSingle(){this.one=true;return this;}
 insert(payload){this.mode='insert';this.payload=payload;return this;}update(payload){this.mode='update';this.payload=payload;return this;}delete(){this.mode='delete';return this;}
 then(resolve,reject){try{let rows=(store[this.table]||[]).filter(r=>this.filters.every(f=>f(r)));if(this.mode==='insert'){const list=[this.payload].flat();rows=list.map(r=>({...r,id:crypto.randomUUID()}));store[this.table].push(...rows);}if(this.mode==='update')rows.forEach(r=>Object.assign(r,this.payload));if(this.mode==='delete')store[this.table]=store[this.table].filter(r=>!rows.includes(r));rows=rows.slice(this.start,this.end+1);return Promise.resolve({data:this.one?(rows[0]||null):rows,error:null}).then(resolve,reject);}catch(e){return Promise.reject(e).then(resolve,reject);}}
}
export const supabase={from:t=>new Query(t),rpc:async(name,p)=>{
if(name==='request_day_correction'){const id=crypto.randomUUID();store.day_corrections.push({id,day_id:p.p_day,requested_name:'Administración · prueba local',requested_by:'admin',requested_at:new Date().toISOString(),reason:p.p_reason,before_data:p.p_before,after_data:p.p_after,applied_immediately:true});Object.assign(store.sale_days.find(d=>d.id===p.p_day),p.p_after);return{data:{id,applied:true},error:null};}
if(name==='review_day_correction'){store.correction_decisions.push({id:crypto.randomUUID(),correction_id:p.p_request,decided_name:'Administración · prueba local',decided_at:new Date().toISOString(),approved:p.p_approve,note:p.p_note});return{data:null,error:null};}
if(name==='save_purchase_plan'){const id=crypto.randomUUID();store.purchase_plans.push({id,...p.p_plan,created_at:new Date().toISOString(),created_by:'admin'});return{data:id,error:null};}
if(name==='save_sale_day')return{data:{day_id:'d1',inserted:p.p_tickets.length,skipped:0,repaired:0},error:null};if(name==='set_day_reviewed')store.sale_days[0].status=p.p_reviewed?'reviewed':'submitted';if(name==='record_inventory_movement')store.inventory_movements.push({id:crypto.randomUUID(),product_id:p.p_product,occurred_at:p.p_at,qty:p.p_qty,kind:p.p_kind,note:p.p_note});return{data:'ok',error:null};},auth:{
 getSession:async()=>({data:{session:location.pathname.includes('index')?null:{user:{id:'admin',email:'prueba@example.invalid'}}},error:null}),
 signOut:async()=>({error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({error:{message:'Invalid login credentials'}}),resetPasswordForEmail:async()=>({error:null})
}};
`;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
};
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/lib/supabase-client.js") {
      res.setHeader("Content-Type", types[".js"]);
      res.end(mock);
      return;
    }
    const rel = decodeURIComponent(
      url.pathname === "/" ? "/index.html" : url.pathname,
    );
    const file = path.resolve(root, "." + rel);
    if (
      !file.startsWith(root) ||
      !types[path.extname(file)] ||
      !fs.existsSync(file)
    ) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.setHeader("Content-Type", types[path.extname(file)]);
    res.setHeader("Cache-Control", "no-store");
    let data = fs.readFileSync(file);
    if (file.endsWith(".html"))
      data = data
        .toString()
        .replace(
          "<body>",
          '<body><div style="padding:8px;text-align:center;background:#fff0cf">PRUEBA LOCAL · datos sintéticos · sin conexión a producción</div>',
        );
    res.end(data);
  })
  .listen(8765, "127.0.0.1", () =>
    console.log("Synthetic UI preview: http://127.0.0.1:8765"),
  );
