import {useState, useEffect, useRef} from 'react';
import {createRoot} from 'react-dom/client';

// ── Supabase ─────────────────────────────────────────────
// La clave anon es pública por diseño: la seguridad la ponen las políticas RLS
// (ver supabase/seguridad.sql). Las escrituras usan el token del admin logueado.
const SB_URL = 'https://jhuwepkpjjvponryzykp.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpodXdlcGtwamp2cG9ucnl6eWtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MTQxNjEsImV4cCI6MjA5Nzk5MDE2MX0.RQddTSo3AtZqdJBhGKDRSv46Wg42iBKPYZeRM6ivCDE';
const BUCKET = 'productos-img';
const PUBLIC_IMG = `${SB_URL}/storage/v1/object/public/${BUCKET}/`;
const REST = {'Content-Type':'application/json','Accept':'application/json','Accept-Profile':'public','Content-Profile':'public'};

// localStorage puede fallar (modo privado, bloqueado): nunca rompe la app
const store = {
  get(k){try{return JSON.parse(localStorage.getItem(k));}catch{return null;}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}},
  del(k){try{localStorage.removeItem(k);}catch{}},
};

// ── Auth (Supabase GoTrue vía REST) ──────────────────────
const SESSION_KEY = 'pacomer.session';
const auth = {
  session: store.get(SESSION_KEY),
  refreshing: null,
  save(s){
    s.expires_at = s.expires_at || Math.floor(Date.now()/1000)+(s.expires_in||3600);
    auth.session = s; store.set(SESSION_KEY,s);
  },
  clear(){auth.session=null;store.del(SESSION_KEY);},
  async signIn(email,password){
    const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'Content-Type':'application/json',apikey:SB_KEY},body:JSON.stringify({email,password})});
    const j = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(r.status===400?'Correo o contraseña incorrectos':(j.error_description||j.msg||`Error ${r.status}`));
    auth.save(j);
  },
  async token(){
    const s = auth.session;
    if(!s) return null;
    if(s.expires_at*1000-Date.now() > 60000) return s.access_token;
    // Un solo refresh a la vez: los refresh tokens rotan
    auth.refreshing = auth.refreshing || (async()=>{
      const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{method:'POST',headers:{'Content-Type':'application/json',apikey:SB_KEY},body:JSON.stringify({refresh_token:s.refresh_token})});
      if(!r.ok){auth.clear();return null;}
      const j = await r.json(); auth.save(j); return j.access_token;
    })().finally(()=>{auth.refreshing=null;});
    return auth.refreshing;
  },
  signOut(){
    const t = auth.session?.access_token;
    auth.clear();
    if(t) fetch(`${SB_URL}/auth/v1/logout`,{method:'POST',headers:{apikey:SB_KEY,Authorization:`Bearer ${t}`}}).catch(()=>{});
  },
};

// Toda petición revisa r.ok: un rechazo de RLS ya no se muestra como "guardado"
async function req(url,{method='GET',headers={},body,signed=false}={}){
  const tok = signed ? await auth.token() : null;
  if(signed&&!tok){const e=new Error('Tu sesión expiró, vuelve a ingresar');e.status=401;throw e;}
  const r = await fetch(url,{method,headers:{apikey:SB_KEY,Authorization:`Bearer ${tok||SB_KEY}`,...headers},body});
  const text = await r.text();
  let data = null; try{data = text?JSON.parse(text):null;}catch{data = text;}
  if(!r.ok){
    const e = new Error(data?.message||data?.msg||data?.error||`Error ${r.status}`);
    e.status = r.status; e.code = data?.code; throw e;
  }
  return data;
}
const NO_ROWS = 'No se guardó: sin permiso o el registro ya no existe';
const sb = {
  get:(t,p='')=>req(`${SB_URL}/rest/v1/${t}?${p}`,{headers:REST}),
  insert:(t,b)=>req(`${SB_URL}/rest/v1/${t}`,{method:'POST',signed:true,headers:{...REST,Prefer:'return=representation'},body:JSON.stringify(b)}),
  upsert:(t,b)=>req(`${SB_URL}/rest/v1/${t}`,{method:'POST',signed:true,headers:{...REST,Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(b)}),
  // Con RLS, un UPDATE/DELETE bloqueado responde 200 con [] → lo tratamos como error
  async patch(t,id,b){
    const rows = await req(`${SB_URL}/rest/v1/${t}?id=eq.${id}`,{method:'PATCH',signed:true,headers:{...REST,Prefer:'return=representation'},body:JSON.stringify(b)});
    if(!rows?.length) throw new Error(NO_ROWS);
    return rows[0];
  },
  async del(t,id){
    const rows = await req(`${SB_URL}/rest/v1/${t}?id=eq.${id}`,{method:'DELETE',signed:true,headers:{...REST,Prefer:'return=representation'}});
    if(!rows?.length) throw new Error(NO_ROWS);
  },
  // Sube un Blob a Storage y devuelve la URL pública
  async uploadImg(blob,prefix){
    const ext = ({'image/webp':'webp','image/jpeg':'jpg','image/png':'png','image/gif':'gif'})[blob.type]||'jpg';
    const path = `${prefix}/${Date.now()}.${ext}`;
    await req(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`,{method:'POST',signed:true,headers:{'Content-Type':blob.type||'image/jpeg','Cache-Control':'max-age=31536000'},body:blob});
    return PUBLIC_IMG+path;
  },
  // Borra una imagen reemplazada; si falla no interrumpe nada
  async removeImg(url){
    if(!url||!url.startsWith(PUBLIC_IMG)) return;
    try{await req(`${SB_URL}/storage/v1/object/${BUCKET}/${url.slice(PUBLIC_IMG.length)}`,{method:'DELETE',signed:true});}
    catch(e){console.warn('No se pudo borrar la imagen anterior',e);}
  },
};

// Reduce fotos del celular (3-8 MB) a ~100-300 KB antes de subirlas
function compressImage(file,max=1200){
  return new Promise(resolve=>{
    if(!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return resolve(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = ()=>{URL.revokeObjectURL(url);resolve(file);};
    img.onload = ()=>{
      URL.revokeObjectURL(url);
      const s = Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth*s); c.height = Math.round(img.naturalHeight*s);
      const ctx = c.getContext('2d');
      ctx.drawImage(img,0,0,c.width,c.height);
      c.toBlob(b=>{
        if(b&&b.type==='image/webp') return resolve(b.size<file.size?b:file);
        // Navegador sin WebP: JPEG con fondo blanco para no ennegrecer transparencias
        ctx.globalCompositeOperation='destination-over'; ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
        c.toBlob(j=>resolve(j&&j.size<file.size?j:file),'image/jpeg',.85);
      },'image/webp',.82);
    };
    img.src = url;
  });
}

// ── Colores ──────────────────────────────────────────────
// em/orangeBtn tienen contraste ≥4.5:1 con texto blanco (WCAG AA); emBright/orange son decorativos
const C={
  em:'#3f7d2a',emD:'#2f6420',emDD:'#24501a',emBright:'#6ab04c',emL:'#e8f5e2',emLL:'#f4fbf0',
  orange:'#e8711a',orangeBtn:'#b3560e',orangeL:'#fef0e6',
  red:'#a31d0b',gold:'#f0a500',white:'#ffffff',bg:'#fdf8f4',card:'#ffffff',grayD:'#6b7280',grayL:'#d1d5db',dark:'#2c1a0e',
};
const CATS=['Proteínas','Carbohidratos','Ensaladas','Bebidas'];
const CAT_ICONS={'Proteínas':'🍖','Carbohidratos':'🍚','Ensaladas':'🥗','Bebidas':'🥤'};
const WA_DEFAULT='573053739928'; // se usa si el negocio no tiene WhatsApp configurado
const TZ='America/Bogota';
const CART_KEY='pacomer.cart';
const CLIENTE_KEY='pacomer.cliente';
const VERSION='v4.0';

const DEFAULT_BIZ={name:'Bufé del Día',slogan:'Lo mejor de la cocina casera',logo:'',portada:''};
// Columnas opcionales de "negocio" (las crea supabase/seguridad.sql)
const BIZ_EXTRA=['whatsapp','hora_abre','hora_cierra'];

const fmt=n=>new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',minimumFractionDigits:0,maximumFractionDigits:0}).format(n);
const sizeLabel=s=>s==='small'?'Pequeño':'Grande';
const plateTotal=items=>items.reduce((s,i)=>s+i.price,0);

// true/false según horario en hora de Colombia; null si no hay horario configurado
function isOpenNow(biz){
  const parse=t=>{const m=/^(\d{1,2}):(\d{2})/.exec(t||'');return m?(+m[1])*60+(+m[2]):null;};
  const a=parse(biz.hora_abre), c=parse(biz.hora_cierra);
  if(a===null||c===null) return null;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const now=(+parts.find(p=>p.type==='hour').value)*60+(+parts.find(p=>p.type==='minute').value);
  return a<=c ? now>=a&&now<c : now>=a||now<c; // soporta horarios que pasan medianoche
}

// ── UI helpers ───────────────────────────────────────────
// Firma de Synaptix AI Labs (estilos .splash__* en index.template.html)
function Firma({readable=false,style}){
  return(
    <div className="splash__sign" aria-hidden={readable?undefined:'true'} style={style}>
      <span className="splash__by">hecho por</span>
      <span className="splash__brand">Synaptix <span className="splash__ai">AI Labs</span></span>
    </div>
  );
}
function Spinner(){
  return <div role="status" aria-label="Cargando" style={{width:36,height:36,border:`3px solid ${C.emL}`,borderTop:`3px solid ${C.em}`,borderRadius:'50%',animation:'spin .8s linear infinite',margin:'0 auto'}}/>;
}
function Btn({children,onClick,color='em',size='md',style={},disabled=false,type='button',...rest}){
  const bg={em:C.em,emD:C.emD,red:C.red,orange:C.orangeBtn,gray:'#e5e7eb'}[color]||C.em;
  const tc=color==='gray'?C.dark:'#fff';
  const pd=size==='sm'?'7px 12px':size==='lg'?'14px 28px':'10px 20px';
  const fs=size==='sm'?'13px':size==='lg'?'16px':'14px';
  return(
    <button type={type} onClick={onClick} disabled={disabled} {...rest} style={{background:disabled?'#d1d5db':bg,color:disabled?'#6b7280':tc,border:'none',borderRadius:10,padding:pd,fontSize:fs,fontWeight:600,cursor:disabled?'not-allowed':'pointer',transition:'all .15s',...style}}>
      {children}
    </button>
  );
}
function Modal({children,onClose,label}){
  const ref=useRef();
  const closeRef=useRef(onClose); closeRef.current=onClose;
  useEffect(()=>{
    const prevFocus=document.activeElement;
    const prevOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    ref.current?.focus();
    const onKey=e=>{
      if(e.key==='Escape'){closeRef.current();return;}
      if(e.key!=='Tab'||!ref.current) return;
      // Mantiene el foco dentro del modal
      const f=[...ref.current.querySelectorAll('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])')].filter(el=>!el.disabled);
      if(!f.length) return;
      if(e.shiftKey&&document.activeElement===f[0]){e.preventDefault();f[f.length-1].focus();}
      else if(!e.shiftKey&&document.activeElement===f[f.length-1]){e.preventDefault();f[0].focus();}
    };
    document.addEventListener('keydown',onKey);
    return()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=prevOverflow;prevFocus?.focus?.();};
  },[]);
  return(
    <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.55)',display:'flex',alignItems:'flex-end',justifyContent:'center',zIndex:1000,animation:'fadeIn .2s'}}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{background:C.white,borderRadius:'20px 20px 0 0',width:'100%',maxWidth:540,maxHeight:'93vh',overflowY:'auto',animation:'slideUp .28s',padding:'22px 18px 36px',outline:'none'}}>
        {children}
      </div>
    </div>
  );
}
function CloseBtn({onClick}){
  return <button onClick={onClick} aria-label="Cerrar" style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.grayD,width:40,height:40,borderRadius:8}}>✕</button>;
}
function Toast({msg}){
  return(
    <div role="status" aria-live="polite" style={{position:'fixed',top:16,left:'50%',transform:'translateX(-50%)',zIndex:2000,pointerEvents:'none'}}>
      {msg&&<div style={{background:msg.startsWith('❌')?C.red:C.emDD,color:'#fff',padding:'10px 20px',borderRadius:10,fontSize:14,fontWeight:600,boxShadow:'0 4px 16px rgba(0,0,0,.2)',maxWidth:'90vw'}}>{msg}</div>}
    </div>
  );
}
function useToast(){
  const [toast,setToast]=useState('');
  const timer=useRef();
  const show=msg=>{setToast(msg);clearTimeout(timer.current);timer.current=setTimeout(()=>setToast(''),msg.startsWith('❌')?4500:2500);};
  return [toast,show];
}
const labelSt={fontSize:13,fontWeight:600,color:C.dark,display:'block',marginBottom:5};
const inputSt={width:'100%',padding:'11px 14px',borderRadius:9,border:`1.5px solid ${C.grayL}`,fontSize:15,background:'#fff'};

// ══════════════════════════════════════════════════════════
// PERFIL ESTILO FACEBOOK
// ══════════════════════════════════════════════════════════
function ProfileHeader({biz}){
  const open=isOpenNow(biz);
  return(
    <header style={{background:C.white,marginBottom:12,boxShadow:'0 1px 4px rgba(0,0,0,.1)'}}>
      {/* Foto portada */}
      <div style={{position:'relative',height:200,overflow:'hidden',background:`linear-gradient(135deg,${C.emDD} 0%,${C.emBright} 40%,${C.orange} 80%,${C.red} 100%)`}}>
        {biz.portada
          ?<img src={biz.portada} alt="" style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/>
          :<div aria-hidden="true" style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',color:'rgba(255,255,255,.3)',fontSize:48}}>🍽️</div>}
        <div style={{position:'absolute',bottom:0,left:0,right:0,height:80,background:'linear-gradient(transparent,rgba(0,0,0,.35))'}}/>
      </div>

      {/* Logo circular + info */}
      <div style={{padding:'0 16px 16px',position:'relative'}}>
        <div style={{
          position:'absolute',top:-44,left:16,width:88,height:88,borderRadius:'50%',border:'4px solid #fff',
          background:`linear-gradient(135deg,${C.emD},${C.emBright})`,display:'flex',alignItems:'center',justifyContent:'center',
          fontSize:36,boxShadow:'0 2px 8px rgba(0,0,0,.2)',overflow:'hidden'
        }}>
          {biz.logo
            ?<img src={biz.logo} alt={`Logo de ${biz.name}`} style={{width:'100%',height:'100%',objectFit:'cover'}}/>
            :<span aria-hidden="true">🍽️</span>}
        </div>
        <div style={{paddingTop:52,paddingLeft:4}}>
          <h1 style={{fontSize:22,fontWeight:800,color:C.dark,lineHeight:1.2}}>{biz.name}</h1>
          {biz.slogan&&<p style={{fontSize:14,color:C.grayD,marginTop:3}}>{biz.slogan}</p>}
          <div style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:6,marginTop:6,fontSize:13}}>
            {open===true&&<span style={{color:C.em,fontWeight:700}}>● Abierto ahora</span>}
            {open===false&&<span style={{color:C.red,fontWeight:700}}>● Cerrado · abre {biz.hora_abre}</span>}
            {open!==null&&<span style={{color:C.grayD}} aria-hidden="true">·</span>}
            <span style={{color:C.grayD}}>Pide por WhatsApp</span>
          </div>
        </div>
      </div>
    </header>
  );
}

// ══════════════════════════════════════════════════════════
// VISTA CLIENTE
// ══════════════════════════════════════════════════════════
// El carrito se guarda solo con ids; al restaurar se reconstruye con precios actuales
const serializeItems=items=>items.map(it=>({id:it.product.id,size:it.size}));
function hydrateItems(saved,byId){
  return (Array.isArray(saved)?saved:[]).map(({id,size})=>{
    const p=byId.get(id);
    const price=p&&(size==='small'?p.p_small:p.p_large);
    return price?{product:p,size,price}:null;
  }).filter(Boolean);
}
function loadCart(products){
  const saved=store.get(CART_KEY);
  const byId=new Map(products.filter(p=>p.active).map(p=>[p.id,p]));
  return {
    cart:(saved?.cart||[]).map(pl=>hydrateItems(pl,byId)).filter(pl=>pl.length),
    current:hydrateItems(saved?.current,byId),
  };
}
const EMPTY_CLIENTE={nombre:'',telefono:'',direccion:'',entrega:'domicilio',pago:'Efectivo',notas:''};
const PAGOS=['Efectivo','Transferencia / Nequi'];
const phoneOk=t=>/^\+?\d{7,13}$/.test(t.replace(/[\s()-]/g,''));

function ItemRow({it,onRemove}){
  return(
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,fontSize:14,color:C.dark,padding:'3px 0'}}>
      <span style={{flex:1}}>{it.product.name} <span style={{color:C.grayD}}>({sizeLabel(it.size)})</span></span>
      <span style={{fontWeight:600}}>{fmt(it.price)}</span>
      <button onClick={onRemove} aria-label={`Quitar ${it.product.name}`} style={{background:'none',border:'none',color:C.red,cursor:'pointer',fontSize:16,width:32,height:32,borderRadius:6}}>✕</button>
    </div>
  );
}

function ClienteView({products,biz}){
  const firstCat=CATS.find(c=>products.some(p=>p.active&&p.cat===c))||CATS[0];
  const [cat,setCat]                   = useState(firstCat);
  const initial                        = useRef(null);
  if(!initial.current) initial.current = loadCart(products);
  const [cart,setCart]                 = useState(initial.current.cart);       // platos guardados: [[item]]
  const [currentPlate,setCurrentPlate] = useState(initial.current.current);
  const [showCart,setShowCart]         = useState(false);
  const [showForm,setShowForm]         = useState(false);
  const [form,setForm]                 = useState(()=>({...EMPTY_CLIENTE,...store.get(CLIENTE_KEY),notas:''}));
  const [touched,setTouched]           = useState(false);
  const [sent,setSent]                 = useState(false);
  const [plateAnim,setPlateAnim]       = useState(false);

  useEffect(()=>{store.set(CART_KEY,{cart:cart.map(serializeItems),current:serializeItems(currentPlate)});},[cart,currentPlate]);

  const activeProd  = products.filter(p=>p.active&&p.cat===cat);
  const totalPlates = cart.length+(currentPlate.length>0?1:0);
  const allItems    = [...cart.flat(),...currentPlate];
  const total       = plateTotal(allItems);
  const delivery    = form.entrega==='domicilio';
  const errors      = {
    nombre:!form.nombre.trim()&&'Escribe tu nombre',
    telefono:!phoneOk(form.telefono)&&'Escribe un teléfono válido (solo números)',
    direccion:delivery&&!form.direccion.trim()&&'Escribe la dirección de entrega',
  };
  const formValid   = !errors.nombre&&!errors.telefono&&!errors.direccion;

  const addItem=(product,size)=>{
    const price=size==='small'?product.p_small:product.p_large;
    setCurrentPlate(prev=>[...prev,{product,size,price}]);
    setPlateAnim(true);setTimeout(()=>setPlateAnim(false),600);
  };
  const savePlate=()=>{
    if(!currentPlate.length)return;
    setCart(prev=>[...prev,currentPlate]);
    setCurrentPlate([]);
  };
  const removePlate=idx=>setCart(prev=>prev.filter((_,i)=>i!==idx));
  const removeItem=(plateIdx,itemIdx)=>setCart(prev=>prev.map((pl,i)=>i===plateIdx?pl.filter((_,j)=>j!==itemIdx):pl).filter(pl=>pl.length));
  const removeCurrentItem=idx=>setCurrentPlate(prev=>prev.filter((_,j)=>j!==idx));

  const sendWA=()=>{
    setTouched(true);
    if(!formValid||!allItems.length)return;
    let txt=`🍽️ *NUEVO PEDIDO — ${biz.name.trim()}*\n\n`;
    txt+=`👤 *${form.nombre.trim()}*\n📞 ${form.telefono.trim()}\n`;
    txt+=delivery?`🛵 Domicilio: ${form.direccion.trim()}\n`:`🏃 Recoge en el local\n`;
    txt+=`💳 Pago: ${form.pago}\n`;
    if(form.notas.trim()) txt+=`📝 Notas: ${form.notas.trim()}\n`;
    txt+='\n';
    const allPlates=currentPlate.length?[...cart,currentPlate]:cart;
    allPlates.forEach((items,i)=>{
      txt+=`*Plato ${i+1}:*\n`;
      items.forEach(it=>{txt+=`  • ${it.product.name.trim()} (${sizeLabel(it.size)}) — ${fmt(it.price)}\n`;});
      txt+=`  💰 _Subtotal: ${fmt(plateTotal(items))}_\n\n`;
    });
    txt+=`━━━━━━━━━━━━━━━\n💰 *TOTAL: ${fmt(total)}*`;
    const url=`https://wa.me/${(biz.whatsapp||WA_DEFAULT).replace(/\D/g,'')}?text=${encodeURIComponent(txt)}`;
    // Si el navegador bloquea la pestaña nueva, abrimos WhatsApp en la misma
    if(!window.open(url,'_blank')) window.location.href=url;
    const {notas,...recordar}=form;
    store.set(CLIENTE_KEY,recordar);
    setShowForm(false);
    setSent(true);
  };
  const resetOrder=()=>{setSent(false);setCart([]);setCurrentPlate([]);setForm(f=>({...f,notas:''}));setTouched(false);};

  if(sent)return(
    <main style={{minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:C.bg,padding:24,textAlign:'center'}}>
      <div aria-hidden="true" style={{fontSize:72,marginBottom:16}}>✅</div>
      <h2 style={{color:C.em,fontSize:24,marginBottom:8}}>¡Pedido listo!</h2>
      <p style={{color:C.grayD,marginBottom:28,lineHeight:1.5}}>Se abrió WhatsApp con tu pedido.<br/>Recuerda tocar <b>Enviar</b> en el chat.</p>
      <Btn size="lg" onClick={resetOrder}>Nuevo pedido</Btn>
      <button onClick={()=>setSent(false)} style={{marginTop:14,background:'none',border:'none',color:C.em,fontWeight:600,fontSize:14,cursor:'pointer',padding:8}}>← Volver a mi pedido</button>
    </main>
  );

  return(
    <main style={{minHeight:'100vh',background:C.bg,paddingBottom:110}}>
      <ProfileHeader biz={biz}/>

      {/* Selector de categorías */}
      <nav aria-label="Categorías" className="cats" style={{display:'flex',gap:8,padding:'0 12px 12px',overflowX:'auto',scrollSnapType:'x mandatory'}}>
        {CATS.map(c=>(
          <button key={c} onClick={()=>setCat(c)} aria-pressed={cat===c} style={{
            flex:'1 0 auto',minWidth:84,padding:'10px 12px',borderRadius:12,border:'none',cursor:'pointer',scrollSnapAlign:'start',
            background:cat===c?C.em:C.white,color:cat===c?'#fff':C.grayD,
            fontWeight:700,fontSize:13,textAlign:'center',whiteSpace:'nowrap',
            boxShadow:cat===c?'0 2px 8px rgba(63,125,42,.35)':'0 1px 3px rgba(0,0,0,.08)',transition:'all .15s'
          }}>
            <div aria-hidden="true" style={{fontSize:22,marginBottom:3}}>{CAT_ICONS[c]}</div>
            {c}
          </button>
        ))}
      </nav>

      {/* Banner plato en curso */}
      {currentPlate.length>0&&(
        <div style={{margin:'0 12px 12px',background:C.orangeL,border:`1px solid ${C.orange}`,borderRadius:10,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
          <span style={{fontSize:14,color:'#7c2d12',fontWeight:600}}>🍽️ Plato {cart.length+1} — {currentPlate.length} ítem{currentPlate.length>1?'s':''} · {fmt(plateTotal(currentPlate))}</span>
          <Btn size="sm" onClick={savePlate}>Guardar plato</Btn>
        </div>
      )}

      {/* Grid productos */}
      <section aria-label={cat} style={{padding:'0 12px',display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))',gap:10,maxWidth:900,margin:'0 auto'}}>
        {activeProd.map(p=>(
          <article key={p.id} style={{background:C.white,borderRadius:14,overflow:'hidden',boxShadow:'0 1px 6px rgba(0,0,0,.08)',display:'flex',flexDirection:'column'}}>
            <div style={{height:110,background:`linear-gradient(135deg,${C.emL},${C.orangeL})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:36}}>
              {p.img
                ?<img src={p.img} alt={p.name} loading="lazy" decoding="async" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                :<span aria-hidden="true">{CAT_ICONS[p.cat]}</span>}
            </div>
            <div style={{padding:'10px 10px 12px',display:'flex',flexDirection:'column',flex:1}}>
              <h3 style={{fontWeight:700,fontSize:14,color:C.dark,marginBottom:2}}>{p.name}</h3>
              <p style={{fontSize:12,color:C.grayD,marginBottom:8,lineHeight:1.4,flex:1}}>{p.descripcion}</p>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {p.p_small>0&&(
                  <button onClick={()=>addItem(p,'small')} aria-label={`Agregar ${p.name} pequeño, ${fmt(p.p_small)}`} style={{background:C.em,border:'none',borderRadius:8,padding:'9px 8px',fontSize:13,color:'#fff',fontWeight:700,cursor:'pointer',display:'flex',justifyContent:'space-between',gap:4}}>
                    <span>+ Pequeño</span><span style={{whiteSpace:'nowrap'}}>{fmt(p.p_small)}</span>
                  </button>
                )}
                {p.p_large>0&&(
                  <button onClick={()=>addItem(p,'large')} aria-label={`Agregar ${p.name} grande, ${fmt(p.p_large)}`} style={{background:C.orangeBtn,border:'none',borderRadius:8,padding:'9px 8px',fontSize:13,color:'#fff',fontWeight:700,cursor:'pointer',display:'flex',justifyContent:'space-between',gap:4}}>
                    <span>+ Grande</span><span style={{whiteSpace:'nowrap'}}>{fmt(p.p_large)}</span>
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
        {activeProd.length===0&&(
          <p style={{color:C.grayD,gridColumn:'1/-1',textAlign:'center',padding:32,fontSize:14}}>Sin productos en esta categoría por ahora</p>
        )}
      </section>

      {/* Botón flotante */}
      {totalPlates>0&&(
        <button onClick={()=>setShowCart(true)} aria-label={`Ver mi pedido: ${totalPlates} plato${totalPlates>1?'s':''}, ${fmt(total)}`} style={{
          position:'fixed',bottom:26,right:18,width:64,height:64,borderRadius:'50%',
          background:`linear-gradient(135deg,${C.em},${C.emD})`,border:'3px solid #fff',boxShadow:'0 6px 20px rgba(63,125,42,.5)',
          fontSize:28,cursor:'pointer',zIndex:200,animation:plateAnim?'popIn .5s':'bounce 2.5s infinite',
          display:'flex',alignItems:'center',justifyContent:'center'
        }}>
          <span aria-hidden="true">🍽️</span>
          <span aria-hidden="true" style={{position:'absolute',top:-5,right:-5,background:C.red,color:'#fff',borderRadius:'50%',width:24,height:24,fontSize:12,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',border:'2px solid #fff'}}>{totalPlates}</span>
        </button>
      )}

      {/* Modal carrito */}
      {showCart&&(
        <Modal label="Tu pedido" onClose={()=>setShowCart(false)}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <h2 style={{color:C.emDD,fontSize:19}}>🛒 Tu pedido</h2>
            <CloseBtn onClick={()=>setShowCart(false)}/>
          </div>
          {cart.map((items,i)=>(
            <div key={i} style={{background:C.emLL,borderRadius:10,padding:'10px 12px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                <span style={{fontWeight:700,color:C.em,fontSize:14}}>Plato {i+1} · {fmt(plateTotal(items))}</span>
                <button onClick={()=>removePlate(i)} style={{background:'none',border:'none',color:C.red,cursor:'pointer',fontSize:13,fontWeight:600,padding:6}}>🗑 Quitar plato</button>
              </div>
              {items.map((it,j)=><ItemRow key={j} it={it} onRemove={()=>removeItem(i,j)}/>)}
            </div>
          ))}
          {currentPlate.length>0&&(
            <div style={{background:'#fffbeb',border:`1px dashed ${C.gold}`,borderRadius:10,padding:'10px 12px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                <span style={{fontWeight:700,color:'#7c2d12',fontSize:14}}>Plato {cart.length+1} (en curso)</span>
                <Btn size="sm" onClick={savePlate}>Guardar plato</Btn>
              </div>
              {currentPlate.map((it,j)=><ItemRow key={j} it={it} onRemove={()=>removeCurrentItem(j)}/>)}
            </div>
          )}
          {allItems.length===0&&<p style={{color:C.grayD,textAlign:'center',padding:24}}>Aún no has agregado nada</p>}
          {allItems.length>0&&(
            <>
              <div style={{borderTop:`2px solid ${C.emL}`,margin:'14px 0',paddingTop:12,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontWeight:700,color:C.dark,fontSize:15}}>Total</span>
                <span style={{fontWeight:800,color:C.emD,fontSize:20}}>{fmt(total)}</span>
              </div>
              <Btn size="lg" style={{width:'100%'}} onClick={()=>{setShowCart(false);setShowForm(true);}}>
                Continuar con el pedido 📲
              </Btn>
            </>
          )}
        </Modal>
      )}

      {/* Modal formulario */}
      {showForm&&(
        <Modal label="Datos de entrega" onClose={()=>setShowForm(false)}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <h2 style={{color:C.emDD,fontSize:19,marginBottom:4}}>📋 Datos de entrega</h2>
              <p style={{color:C.grayD,fontSize:14,marginBottom:18}}>Total: <b style={{color:C.dark}}>{fmt(total)}</b></p>
            </div>
            <CloseBtn onClick={()=>setShowForm(false)}/>
          </div>
          <form onSubmit={e=>{e.preventDefault();sendWA();}} noValidate>
            <fieldset style={{border:'none',marginBottom:14}}>
              <legend style={labelSt}>¿Cómo lo recibes?</legend>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                {[['domicilio','🛵 Domicilio'],['recoger','🏃 Recojo en el local']].map(([v,l])=>(
                  <button type="button" key={v} aria-pressed={form.entrega===v} onClick={()=>setForm(f=>({...f,entrega:v}))} style={{padding:'11px 8px',borderRadius:9,cursor:'pointer',fontSize:14,fontWeight:600,border:`2px solid ${form.entrega===v?C.em:C.grayL}`,background:form.entrega===v?C.emLL:'#fff',color:form.entrega===v?C.emDD:C.grayD}}>{l}</button>
                ))}
              </div>
            </fieldset>
            {[
              ['nombre','👤 Nombre completo','text','Tu nombre...','name'],
              ['telefono','📞 Teléfono','tel','3001234567','tel'],
              ...(delivery?[['direccion','📍 Dirección de entrega','text','Barrio, calle, número...','street-address']]:[]),
            ].map(([k,l,t,ph,ac])=>(
              <div key={k} style={{marginBottom:14}}>
                <label htmlFor={`f-${k}`} style={labelSt}>{l}</label>
                <input id={`f-${k}`} type={t} inputMode={k==='telefono'?'tel':undefined} autoComplete={ac} value={form[k]} placeholder={ph}
                  onChange={e=>setForm(v=>({...v,[k]:e.target.value}))}
                  aria-invalid={touched&&!!errors[k]} aria-describedby={touched&&errors[k]?`e-${k}`:undefined}
                  style={{...inputSt,borderColor:touched&&errors[k]?C.red:form[k]?C.em:C.grayL}}/>
                {touched&&errors[k]&&<p id={`e-${k}`} style={{color:C.red,fontSize:13,marginTop:4}}>{errors[k]}</p>}
              </div>
            ))}
            <div style={{marginBottom:14}}>
              <label htmlFor="f-pago" style={labelSt}>💳 Método de pago</label>
              <select id="f-pago" value={form.pago} onChange={e=>setForm(f=>({...f,pago:e.target.value}))} style={inputSt}>
                {PAGOS.map(p=><option key={p}>{p}</option>)}
              </select>
            </div>
            <div style={{marginBottom:16}}>
              <label htmlFor="f-notas" style={labelSt}>📝 Notas (opcional)</label>
              <textarea id="f-notas" rows={2} value={form.notas} placeholder="Sin cebolla, con cambio de $50.000..." onChange={e=>setForm(f=>({...f,notas:e.target.value}))} style={{...inputSt,resize:'vertical'}}/>
            </div>
            <Btn type="submit" size="lg" style={{width:'100%'}}>Enviar por WhatsApp 🚀</Btn>
          </form>
        </Modal>
      )}
    </main>
  );
}

// ══════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════
function ImagePicker({value,onPick,uploading,round=false,hint,height=120}){
  const ref=useRef();
  return(
    <div style={{display:'flex',alignItems:'center',gap:14,flexDirection:round?'row':'column'}}>
      <button type="button" onClick={()=>ref.current.click()} disabled={uploading} aria-label={value?'Cambiar imagen':'Subir imagen'} style={{
        width:round?80:'100%',height:round?80:height,borderRadius:round?'50%':12,cursor:uploading?'wait':'pointer',flexShrink:0,padding:0,
        background:`linear-gradient(135deg,${C.emL},${C.emLL})`,border:`2px dashed ${C.em}`,overflow:'hidden',
        display:'flex',alignItems:'center',justifyContent:'center',fontSize:round?26:30,color:C.emDD
      }}>
        {uploading?<span style={{fontSize:13,fontWeight:600}}>⏳ Subiendo...</span>
          :value?<img src={value} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
          :<span style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}><span aria-hidden="true">📷</span><span style={{fontSize:12,fontWeight:600}}>Toca para subir</span></span>}
      </button>
      <input ref={ref} type="file" accept="image/*" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];e.target.value='';if(f)onPick(f);}}/>
      {(value||hint)&&(
        <div style={{alignSelf:round?'center':'flex-start'}}>
          {hint&&<p style={{fontSize:12,color:C.grayD}}>{hint}</p>}
          {value&&!uploading&&<button type="button" onClick={()=>onPick(null)} style={{background:'none',border:'none',color:C.red,fontSize:13,cursor:'pointer',marginTop:4,fontWeight:600,padding:'4px 0'}}>✕ Quitar imagen</button>}
        </div>
      )}
    </div>
  );
}

function AdminView({products,setProducts,biz,setBiz,onLogout}){
  const [tab,setTab]           = useState('negocio');
  const [editing,setEditing]   = useState(null);   // producto original (o null si es nuevo)
  const [showForm,setShowForm] = useState(false);
  const [saving,setSaving]     = useState(false);
  const [uploading,setUploading] = useState('');   // 'logo' | 'portada' | 'img' | ''
  const [toast,showToast]      = useToast();
  const [bizForm,setBizForm]   = useState({...biz});
  const empty={name:'',cat:CATS[0],descripcion:'',img:'',p_small:'',p_large:'',active:true};
  const [form,setForm]         = useState(empty);
  const [formErr,setFormErr]   = useState('');
  const hasExtra = BIZ_EXTRA.every(k=>biz._cols?.includes(k));

  const fail=e=>{
    console.error(e);
    if(e.status===401){showToast('❌ Tu sesión expiró, vuelve a ingresar');setTimeout(onLogout,1500);return;}
    showToast('❌ '+(e.message||'Error al guardar'));
  };

  const openNew =()=>{setForm(empty);setEditing(null);setFormErr('');setShowForm(true);};
  const openEdit=p=>{setForm({...p});setEditing(p);setFormErr('');setShowForm(true);};

  const upload=(key,prefix,max,apply)=>async file=>{
    if(!file){apply('');return;}
    setUploading(key);
    try{apply(await sb.uploadImg(await compressImage(file,max),prefix));}
    catch(e){fail(e);}
    setUploading('');
  };

  const save=async()=>{
    const p_small=Number(form.p_small)||0, p_large=Number(form.p_large)||0;
    if(!form.name.trim()) return setFormErr('Escribe el nombre del producto');
    if(p_small<=0&&p_large<=0) return setFormErr('Pon al menos un precio mayor que 0');
    if(p_small<0||p_large<0) return setFormErr('Los precios no pueden ser negativos');
    setFormErr('');
    setSaving(true);
    const data={name:form.name.trim(),cat:form.cat,descripcion:(form.descripcion||'').trim(),img:form.img||'',p_small,p_large,active:form.active};
    try{
      if(editing){
        const row=await sb.patch('productos',editing.id,data);
        setProducts(prev=>prev.map(p=>p.id===editing.id?row:p));
        if(editing.img!==data.img) sb.removeImg(editing.img);
      } else {
        let rows;
        try{rows=await sb.insert('productos',[data]);}
        catch(e){
          // Si la columna id aún no es autoincremental (falta correr seguridad.sql)
          if(e.code!=='23502') throw e;
          rows=await sb.insert('productos',[{...data,id:Date.now()}]);
        }
        setProducts(prev=>[...prev,rows[0]]);
      }
      setShowForm(false);
      showToast(editing?'✅ Producto actualizado':'✅ Producto agregado');
    }catch(e){fail(e);}
    setSaving(false);
  };

  const closeForm=()=>{
    // Imagen subida pero producto no guardado: no dejarla huérfana
    if(form.img&&form.img!==editing?.img) sb.removeImg(form.img);
    setShowForm(false);
  };

  const del=async p=>{
    if(!confirm(`¿Eliminar "${p.name.trim()}"? Esta acción no se puede deshacer.`))return;
    try{
      await sb.del('productos',p.id);
      setProducts(prev=>prev.filter(x=>x.id!==p.id));
      sb.removeImg(p.img);
      showToast('🗑 Eliminado');
    }catch(e){fail(e);}
  };
  const toggle=async p=>{
    try{
      const row=await sb.patch('productos',p.id,{active:!p.active});
      setProducts(prev=>prev.map(x=>x.id===p.id?row:x));
    }catch(e){fail(e);}
  };

  const saveBiz=async()=>{
    if(!bizForm.name?.trim()) return showToast('❌ El nombre del negocio es obligatorio');
    if(hasExtra&&bizForm.whatsapp&&!/^\d{10,13}$/.test(bizForm.whatsapp.replace(/\D/g,''))) return showToast('❌ WhatsApp: escribe el número con indicativo, ej. 573001234567');
    setSaving(true);
    const row={id:1,name:bizForm.name.trim(),logo:bizForm.logo||'',portada:bizForm.portada||'',slogan:(bizForm.slogan||'').trim()};
    if(hasExtra) BIZ_EXTRA.forEach(k=>{row[k]=(bizForm[k]||'').trim()||null;});
    if(row.whatsapp) row.whatsapp=row.whatsapp.replace(/\D/g,'');
    try{
      const [saved]=await sb.upsert('negocio',[row]);
      if(!saved) throw new Error(NO_ROWS);
      if(biz.logo!==row.logo) sb.removeImg(biz.logo);
      if(biz.portada!==row.portada) sb.removeImg(biz.portada);
      const next={...DEFAULT_BIZ,...saved,_cols:Object.keys(saved)};
      setBiz(next); setBizForm(next);
      showToast('✅ Negocio guardado');
    }catch(e){fail(e);}
    setSaving(false);
  };

  return(
    <div style={{minHeight:'100vh',background:'#f9fafb',paddingBottom:40}}>
      <Toast msg={toast}/>

      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${C.emDD},${C.emD},${C.orangeBtn})`,padding:'16px',color:'#fff',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:38,height:38,borderRadius:'50%',background:'rgba(255,255,255,.15)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,border:'2px solid rgba(255,255,255,.3)',overflow:'hidden'}}>
            {biz.logo?<img src={biz.logo} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>:'⚙️'}
          </div>
          <div>
            <h1 style={{fontSize:16,fontWeight:800}}>Administración</h1>
            <p style={{fontSize:12,opacity:.85}}>{auth.session?.user?.email}</p>
          </div>
        </div>
        <button onClick={onLogout} style={{background:'rgba(255,255,255,.15)',border:'1px solid rgba(255,255,255,.35)',color:'#fff',borderRadius:8,padding:'8px 14px',cursor:'pointer',fontSize:13,fontWeight:600}}>Salir →</button>
      </div>

      {/* Tabs */}
      <div role="tablist" style={{display:'flex',background:'#fff',borderBottom:'2px solid #e5e7eb'}}>
        {[{k:'negocio',l:'🏪 Negocio'},{k:'productos',l:`📦 Productos (${products.length})`}].map(t=>(
          <button key={t.k} role="tab" aria-selected={tab===t.k} onClick={()=>setTab(t.k)} style={{flex:1,padding:'13px 8px',border:'none',cursor:'pointer',fontWeight:600,fontSize:14,background:tab===t.k?C.emLL:'#fff',color:tab===t.k?C.em:C.grayD,borderBottom:tab===t.k?`3px solid ${C.em}`:'3px solid transparent',transition:'all .15s'}}>{t.l}</button>
        ))}
      </div>

      {/* TAB NEGOCIO */}
      {tab==='negocio'&&(
        <div style={{padding:16,maxWidth:500,margin:'0 auto'}}>
          <h2 style={{color:C.emDD,fontSize:16,fontWeight:700,marginBottom:16}}>Información del negocio</h2>

          <div style={{marginBottom:20}}>
            <span style={labelSt}>📸 Foto de portada</span>
            <ImagePicker value={bizForm.portada} height={140} uploading={uploading==='portada'}
              onPick={upload('portada','negocio',1600,v=>setBizForm(f=>({...f,portada:v})))}/>
          </div>
          <div style={{marginBottom:20}}>
            <span style={labelSt}>🖼️ Logo (circular)</span>
            <ImagePicker round value={bizForm.logo} hint="Aparece como foto de perfil" uploading={uploading==='logo'}
              onPick={upload('logo','negocio',512,v=>setBizForm(f=>({...f,logo:v})))}/>
          </div>

          {[['name','🏪 Nombre del negocio','Bufé Doña Martha'],['slogan','💬 Slogan o descripción','Lo mejor de la cocina casera']].map(([k,l,ph])=>(
            <div key={k} style={{marginBottom:16}}>
              <label htmlFor={`b-${k}`} style={labelSt}>{l}</label>
              <input id={`b-${k}`} value={bizForm[k]||''} onChange={e=>setBizForm(f=>({...f,[k]:e.target.value}))} placeholder={ph} style={inputSt}/>
            </div>
          ))}

          {hasExtra?(
            <>
              <div style={{marginBottom:16}}>
                <label htmlFor="b-wa" style={labelSt}>📲 WhatsApp que recibe los pedidos</label>
                <input id="b-wa" inputMode="tel" value={bizForm.whatsapp||''} onChange={e=>setBizForm(f=>({...f,whatsapp:e.target.value}))} placeholder={WA_DEFAULT} style={inputSt}/>
                <p style={{fontSize:12,color:C.grayD,marginTop:4}}>Con indicativo de país, sin + ni espacios (57 + número)</p>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:6}}>
                {[['hora_abre','🕖 Abre'],['hora_cierra','🕘 Cierra']].map(([k,l])=>(
                  <div key={k}>
                    <label htmlFor={`b-${k}`} style={labelSt}>{l}</label>
                    <input id={`b-${k}`} type="time" value={(bizForm[k]||'').slice(0,5)} onChange={e=>setBizForm(f=>({...f,[k]:e.target.value}))} style={inputSt}/>
                  </div>
                ))}
              </div>
              <p style={{fontSize:12,color:C.grayD,marginBottom:16}}>Deja el horario vacío para no mostrar “Abierto / Cerrado”.</p>
            </>
          ):(
            <p style={{fontSize:13,color:'#7c2d12',background:C.orangeL,padding:'10px 12px',borderRadius:8,marginBottom:16}}>
              Para configurar WhatsApp y horario desde aquí, ejecuta <code>supabase/seguridad.sql</code> en Supabase.
            </p>
          )}

          <Btn size="lg" style={{width:'100%'}} disabled={saving||!!uploading} onClick={saveBiz}>
            {saving?'Guardando...':'Guardar cambios ☁️'}
          </Btn>

          <div style={{marginTop:20,borderRadius:12,overflow:'hidden',boxShadow:'0 2px 12px rgba(0,0,0,.1)'}}>
            <p style={{fontSize:12,color:C.grayD,padding:'8px 12px',background:'#f3f4f6',fontWeight:600}}>Vista previa del perfil:</p>
            <ProfileHeader biz={bizForm}/>
          </div>
        </div>
      )}

      {/* TAB PRODUCTOS */}
      {tab==='productos'&&(
        <div style={{padding:16,maxWidth:700,margin:'0 auto'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <p style={{fontSize:14,color:C.grayD}}>{products.filter(p=>p.active).length} activos · {products.length} total</p>
            <Btn size="sm" onClick={openNew}>+ Nuevo</Btn>
          </div>
          {CATS.map(cat=>{
            const list=products.filter(p=>p.cat===cat);
            return(
              <section key={cat} style={{marginBottom:20}}>
                <h3 style={{color:C.emDD,fontSize:14,fontWeight:700,marginBottom:8,padding:'7px 12px',background:C.emL,borderRadius:8}}>{CAT_ICONS[cat]} {cat}</h3>
                {list.map(p=>(
                  <div key={p.id} style={{background:'#fff',borderRadius:10,padding:'11px 12px',marginBottom:8,display:'flex',gap:10,alignItems:'center',boxShadow:'0 1px 4px rgba(0,0,0,.06)'}}>
                    <div style={{width:46,height:46,borderRadius:8,flexShrink:0,overflow:'hidden',background:`linear-gradient(135deg,${C.emL},${C.emLL})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,opacity:p.active?1:.5}}>
                      {p.img?<img src={p.img} alt="" loading="lazy" style={{width:'100%',height:'100%',objectFit:'cover'}}/>:CAT_ICONS[p.cat]}
                    </div>
                    <div style={{flex:1,minWidth:0,opacity:p.active?1:.6}}>
                      <p style={{fontWeight:700,fontSize:14,color:C.dark}}>{p.name}</p>
                      <p style={{fontSize:12,color:C.grayD}}>{p.p_small>0?fmt(p.p_small):'—'}{p.p_large>0?` / ${fmt(p.p_large)}`:''}</p>
                    </div>
                    <div style={{display:'flex',gap:5,flexShrink:0,flexWrap:'wrap',justifyContent:'flex-end'}}>
                      <button onClick={()=>toggle(p)} aria-pressed={p.active} style={{background:p.active?'#dcfce7':'#fef3c7',border:'none',borderRadius:6,padding:'6px 9px',fontSize:12,cursor:'pointer',fontWeight:600,color:p.active?'#166534':'#92400e'}}>{p.active?'✓ Activo':'Oculto'}</button>
                      <button onClick={()=>openEdit(p)} style={{background:'#eff6ff',border:'none',borderRadius:6,padding:'6px 9px',fontSize:12,cursor:'pointer',color:'#1d4ed8',fontWeight:600}}>Editar</button>
                      <button onClick={()=>del(p)} aria-label={`Eliminar ${p.name}`} style={{background:'#fef2f2',border:'none',borderRadius:6,padding:'6px 9px',fontSize:12,cursor:'pointer',color:C.red,fontWeight:600}}>🗑</button>
                    </div>
                  </div>
                ))}
                {list.length===0&&<p style={{color:C.grayD,fontSize:13,padding:'6px 10px'}}>Sin productos</p>}
              </section>
            );
          })}
        </div>
      )}

      {/* Modal producto */}
      {showForm&&(
        <Modal label={editing?'Editar producto':'Nuevo producto'} onClose={closeForm}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <h2 style={{color:C.emDD,fontSize:18}}>{editing?'Editar producto':'Nuevo producto'}</h2>
            <CloseBtn onClick={closeForm}/>
          </div>
          <div style={{marginBottom:14}}>
            <ImagePicker value={form.img} height={120} uploading={uploading==='img'}
              onPick={upload('img','productos',1200,v=>setForm(f=>{
                // Reemplazo antes de guardar: borra la subida intermedia, no la original
                if(f.img&&f.img!==editing?.img) sb.removeImg(f.img);
                return {...f,img:v};
              }))}/>
          </div>
          {[['name','Nombre del producto','Ej: Pollo asado'],['descripcion','Descripción corta','Ej: Con arroz y ensalada']].map(([k,l,ph])=>(
            <div key={k} style={{marginBottom:12}}>
              <label htmlFor={`p-${k}`} style={labelSt}>{l}</label>
              <input id={`p-${k}`} value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} placeholder={ph} style={inputSt}/>
            </div>
          ))}
          <div style={{marginBottom:12}}>
            <label htmlFor="p-cat" style={labelSt}>Categoría</label>
            <select id="p-cat" value={form.cat} onChange={e=>setForm(f=>({...f,cat:e.target.value}))} style={inputSt}>
              {CATS.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:6}}>
            {[['p_small','💚 Precio pequeño'],['p_large','🌟 Precio grande']].map(([k,l])=>(
              <div key={k}>
                <label htmlFor={`p-${k}`} style={labelSt}>{l}</label>
                <input id={`p-${k}`} type="number" inputMode="numeric" min="0" step="500" value={form[k]} placeholder="0"
                  onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} style={inputSt}/>
              </div>
            ))}
          </div>
          <p style={{fontSize:12,color:C.grayD,marginBottom:12}}>Deja un precio en 0 si ese tamaño no aplica.</p>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:14,color:C.dark,marginBottom:16,cursor:'pointer'}}>
            <input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))} style={{width:18,height:18}}/>
            Visible en el menú
          </label>
          {formErr&&<p role="alert" style={{color:C.red,fontSize:13,marginBottom:10}}>{formErr}</p>}
          <div style={{display:'flex',gap:10}}>
            <Btn color="gray" onClick={closeForm} style={{flex:1}}>Cancelar</Btn>
            <Btn onClick={save} disabled={saving||!!uploading} style={{flex:1}}>{saving?'Guardando...':uploading?'Subiendo imagen...':editing?'Guardar':'Agregar'}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// LOGIN (Supabase Auth)
// ══════════════════════════════════════════════════════════
function AdminLogin({onLogin,onCancel}){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [err,setErr]=useState('');
  const [busy,setBusy]=useState(false);
  const submit=async e=>{
    e.preventDefault();
    if(!email||!password)return setErr('Escribe tu correo y contraseña');
    setBusy(true);setErr('');
    try{await auth.signIn(email.trim(),password);onLogin();}
    catch(e2){setErr(e2.message);setPassword('');}
    setBusy(false);
  };
  return(
    <main style={{minHeight:'100vh',background:`linear-gradient(135deg,${C.emDD},${C.em})`,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <form onSubmit={submit} style={{background:'#fff',borderRadius:20,padding:'32px 24px',width:'100%',maxWidth:340,textAlign:'center',boxShadow:'0 20px 60px rgba(0,0,0,.2)'}}>
        <div aria-hidden="true" style={{fontSize:52,marginBottom:12}}>🔐</div>
        <h2 style={{color:C.emDD,marginBottom:6,fontSize:20}}>Acceso Admin</h2>
        <p style={{color:C.grayD,fontSize:14,marginBottom:22}}>Ingresa con tu cuenta de administrador</p>
        <div style={{textAlign:'left'}}>
          <label htmlFor="l-email" style={labelSt}>Correo</label>
          <input id="l-email" type="email" autoComplete="username" value={email} onChange={e=>{setEmail(e.target.value);setErr('');}} style={{...inputSt,marginBottom:12}}/>
          <label htmlFor="l-pass" style={labelSt}>Contraseña</label>
          <input id="l-pass" type="password" autoComplete="current-password" value={password} onChange={e=>{setPassword(e.target.value);setErr('');}} style={{...inputSt,marginBottom:8,borderColor:err?C.red:C.grayL}}/>
        </div>
        {err&&<p role="alert" style={{color:C.red,fontSize:13,marginBottom:8}}>{err}</p>}
        <Btn type="submit" size="lg" style={{width:'100%',marginTop:8}} disabled={busy}>{busy?'Entrando...':'Entrar'}</Btn>
        <button type="button" onClick={onCancel} style={{marginTop:14,background:'none',border:'none',color:C.grayD,fontSize:13,cursor:'pointer',padding:6}}>← Volver al menú</button>
      </form>
    </main>
  );
}

// ══════════════════════════════════════════════════════════
// APP
// ══════════════════════════════════════════════════════════
const wantsAdmin=()=>location.hash==='#admin';

function App(){
  const [products,setProducts]=useState([]);
  const [biz,setBiz]=useState(DEFAULT_BIZ);
  const [view,setView]=useState(()=>wantsAdmin()?(auth.session?'admin':'adminLogin'):'cliente');
  const [status,setStatus]=useState('loading'); // loading | ok | error
  const [tapCount,setTapCount]=useState(0);
  const tapTimer=useRef(null);

  const load=async()=>{
    setStatus('loading');
    try{
      const [prods,bizData]=await Promise.all([sb.get('productos','order=id'),sb.get('negocio','id=eq.1')]);
      setProducts(prods);
      if(bizData.length) setBiz({...DEFAULT_BIZ,...bizData[0],_cols:Object.keys(bizData[0])});
      setStatus('ok');
    }catch(e){
      // Sin datos de ejemplo: mostrar precios falsos generaría pedidos inválidos
      console.error('Error cargando datos de Supabase:',e);
      setStatus('error');
    }
  };
  useEffect(()=>{load();},[]);
  // Solo con datos reales: evita que la pestaña muestre el nombre por defecto mientras carga
  useEffect(()=>{if(biz._cols)document.title=`${biz.name.trim()} · Menú`;},[biz]);
  useEffect(()=>{
    const onHash=()=>{if(wantsAdmin())setView(auth.session?'admin':'adminLogin');};
    window.addEventListener('hashchange',onHash);
    return()=>window.removeEventListener('hashchange',onHash);
  },[]);

  const goCliente=()=>{if(wantsAdmin())history.replaceState(null,'',location.pathname+location.search);setView('cliente');};
  const handleFooterTap=()=>{
    setTapCount(n=>n+1);
    clearTimeout(tapTimer.current);
    tapTimer.current=setTimeout(()=>setTapCount(0),900);
  };
  useEffect(()=>{if(tapCount>=3){setView(auth.session?'admin':'adminLogin');setTapCount(0);}},[tapCount]);

  if(status==='loading')return(
    <div className="splash" style={{minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:C.bg,gap:16,position:'relative'}}>
      <Spinner/>
      <p style={{color:C.em,fontSize:14,fontWeight:600}}>Cargando menú...</p>
      <Firma/>
    </div>
  );

  if(view==='adminLogin')return <AdminLogin onLogin={()=>setView('admin')} onCancel={goCliente}/>;
  if(view==='admin'){
    if(!auth.session) return <AdminLogin onLogin={()=>setView('admin')} onCancel={goCliente}/>;
    return <AdminView products={products} setProducts={setProducts} biz={biz} setBiz={setBiz} onLogout={()=>{auth.signOut();goCliente();}}/>;
  }

  return(
    <div>
      {status==='error'?(
        <main style={{minHeight:'90vh',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:24,textAlign:'center',background:C.bg}}>
          <div aria-hidden="true" style={{fontSize:56,marginBottom:12}}>📡</div>
          <h2 style={{color:C.dark,fontSize:20,marginBottom:8}}>No pudimos cargar el menú</h2>
          <p style={{color:C.grayD,fontSize:14,marginBottom:22}}>Revisa tu conexión a internet e inténtalo de nuevo.</p>
          <Btn size="lg" onClick={load}>Reintentar</Btn>
        </main>
      ):(
        <ClienteView products={products} biz={biz}/>
      )}
      <footer onClick={handleFooterTap} style={{textAlign:'center',padding:'12px 16px 8px',background:C.bg,borderTop:`1px solid ${C.emL}`}}>
        <p style={{fontSize:11,color:C.grayD,userSelect:'none',marginBottom:6}}>© {biz.name.trim()} · {VERSION}</p>
        <Firma readable/>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
