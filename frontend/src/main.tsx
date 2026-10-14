import React,{useEffect,useState} from "react";
import{createRoot}from"react-dom/client";
import"./style.css";

const API=import.meta.env.VITE_API_BASE||"/api";
const POSTER=(path?:string|null,w=185)=>path?`https://image.tmdb.org/t/p/w${w}${path}`:"";

let onUnauthorized:()=>void=()=>{};
function setOnUnauthorized(fn:()=>void){onUnauthorized=fn}

async function apiFetch(path:string, init:RequestInit={}){
  const headers=new Headers(init.headers||{});
  if(init.body && !headers.has("Content-Type")) headers.set("Content-Type","application/json");
  const r=await fetch(`${API}${path}`,{...init,credentials:"include",headers});
  if(r.status===401) onUnauthorized();
  return r;
}

function size(n:number){const u=["B","Ko","Mo","Go","To"];let v=n||0,i=0;while(v>=1024&&i<u.length-1){v/=1024;i++}return `${v.toFixed(i>=3?2:0)} ${u[i]}`}
function rate(n:number){return `${size(n||0)}/s`}
function eta(s?:number|null){
  if(s==null||s<0)return "ETA indisponible";
  if(s<60)return `${Math.round(s)} s`;
  if(s<3600)return `${Math.floor(s/60)} min`;
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
  return m?`${h} h ${m} min`:`${h} h`;
}
function fmtDate(s?:string|null){
  if(!s)return "";
  const d=new Date(s+"T00:00:00");
  if(Number.isNaN(d.getTime()))return s;
  return d.toLocaleDateString("fr-FR",{day:"numeric",month:"short",year:"numeric"});
}
function Poster({path,w=185,className="poster"}:{path?:string|null;w?:number;className?:string}){
  return path?<img className={className} src={POSTER(path,w)} alt="" loading="lazy"/>:<div className={`${className} empty`} aria-hidden/>;
}
function Brand({tagline}:{tagline?:string}){
  return <div className="brand">
    <span className="logo" aria-hidden="true"/>
    <div>
      <h1>Les envies pour Plex</h1>
      {tagline!==undefined&&<p className="tagline">{tagline}</p>}
    </div>
  </div>;
}
function statusKind(s?:string){
  const k=(s||"").toLowerCase();
  if(k==="waiting")return "waiting";
  if(k==="paused")return "paused";
  if(k==="found")return "found";
  if(k==="downloading")return "downloading";
  return "missing";
}

type GrabDownloadSettings={
  quality_required_language:string;
  quality_preferred_resolution:string;
  quality_preferred_codecs:string;
  quality_max_size_gb:number;
  quality_allowed_sources:string;
  quality_min_seeders:number;
  c411_categories:string;
  c411_request_delay_seconds:number;
  transmission_download_dir:string;
  plex_url:string;
  plex_token:string;
  show_force_title_mismatch:boolean;
};

type DiscoverySettings={
  min_rating:number;
  min_votes:number;
  released_days:number;
  popularity_days:number;
  upcoming_days:number;
  max_results:number;
  auto_add_nouveautes:boolean;
  auto_add_attendus:boolean;
  auto_add_classiques:boolean;
  auto_download:boolean;
  classic_min_rating:number;
  classic_min_votes:number;
  classic_min_age_years:number;
};

const WISH_STATUS:{[k:string]:string}={WAITING:"En attente",PAUSED:"En pause",FOUND:"Trouvé",DOWNLOADING:"Téléchargement"};
const DISC_CACHE_KEY="discovery-lists-v3";
type DiscoveryLists={nouveautes:any[];attendus:any[];classiques:any[];nouveautes_source?:string};

function readDiscCache(){
  try{
    const d=JSON.parse(localStorage.getItem(DISC_CACHE_KEY)||"null");
    if(!d||!Array.isArray(d.nouveautes)||!Array.isArray(d.attendus)) return null;
    return {
      nouveautes:d.nouveautes,
      attendus:d.attendus,
      classiques:Array.isArray(d.classiques)?d.classiques:[],
      nouveautes_source:d.nouveautes_source==="tmdb"?"tmdb":"c411",
      savedAt:typeof d.savedAt==="number"?d.savedAt:null,
    };
  }catch{return null}
}
function writeDiscCache(data:DiscoveryLists, savedAt=Date.now()){
  try{
    localStorage.setItem(DISC_CACHE_KEY, JSON.stringify({
      nouveautes:data.nouveautes||[],
      attendus:data.attendus||[],
      classiques:data.classiques||[],
      nouveautes_source:data.nouveautes_source==="tmdb"?"tmdb":"c411",
      savedAt,
    }));
  }catch{}
}
const POP_PERIODS:[number,string][]=[[1,"24 h"],[7,"7 j"],[30,"30 j"]];
function popPeriodLabel(days?:number){
  return POP_PERIODS.find(([d])=>d===Number(days))?.[1]||"7 j";
}
function fmtGrabs(n:number){
  const v=Math.round(Number(n)||0);
  if(v>=10000) return `${Math.round(v/1000)}k`;
  if(v>=1000) return `${(v/1000).toFixed(1).replace(".",",")}k`;
  return v.toLocaleString("fr-FR");
}
function fmtWhen(ts?:number|null){
  if(!ts) return "";
  return new Date(ts).toLocaleString("fr-FR",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
}
function plexFallback(title?:string, year?:number){
  const q=[title,year].filter(Boolean).join(" ");
  return q?`https://app.plex.tv/desktop/#!/search?query=${encodeURIComponent(String(q))}`:"";
}

function Login({onOk}:{onOk:()=>void}){
  const[username,setUsername]=useState("");
  const[password,setPassword]=useState("");
  const[err,setErr]=useState("");
  const[busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){
    e.preventDefault();
    setBusy(true);setErr("");
    try{
      const r=await fetch(`${API}/auth/login`,{
        method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({username,password}),
        signal:AbortSignal.timeout(8000)
      });
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(typeof d.detail==="string"?d.detail:"Identifiants incorrects");
      onOk();
    }catch(e:any){
      const timeout=e?.name==="TimeoutError"||e?.name==="AbortError";
      setErr(timeout?"Serveur injoignable. Réessayez.":e?.message||"Connexion impossible")
    }
    finally{setBusy(false)}
  }
  return <main className="login-wrap">
    <form className="panel login-card" onSubmit={submit}>
      <Brand tagline="Vos films, de l'envie à Plex"/>
      <p className="muted">Connexion requise pour accéder à l'interface.</p>
      <label>Identifiant<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" autoFocus/></label>
      <label>Mot de passe<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label>
      {err&&<p className="empty-msg">{err}</p>}
      <button type="submit" disabled={busy||!username||!password}>{busy?"Connexion…":"Se connecter"}</button>
    </form>
  </main>;
}

function App({onLogout,authRequired}:{onLogout:()=>void;authRequired:boolean}){
  const[q,setQ]=useState(""),[results,setResults]=useState<any[]>([]),[movie,setMovie]=useState<any>(null);
  const[releases,setReleases]=useState<any[]>([]),[wishlist,setWishlist]=useState<any[]>([]),[downloads,setDownloads]=useState<any[]>([]),[busy,setBusy]=useState(false);
  const[dlError,setDlError]=useState("");
  const[busyMsg,setBusyMsg]=useState("");
  const[searched,setSearched]=useState(false),[searchMsg,setSearchMsg]=useState(""),[searchSources,setSearchSources]=useState<any>(null);
  const[searchingWishId,setSearchingWishId]=useState<number|null>(null);
  const[dlState,setDlState]=useState<{id:number;status:"loading"|"ok"|"error";msg?:string}|null>(null);
  const[c411Tried,setC411Tried]=useState(false),[c411Msg,setC411Msg]=useState(""),[c411Err,setC411Err]=useState(false);
  const[showSettings,setShowSettings]=useState(false),[savingSettings,setSavingSettings]=useState(false);
  const[settingsMsg,setSettingsMsg]=useState("");
  const[editingWishId,setEditingWishId]=useState<number|null>(null);
  const[editAuto,setEditAuto]=useState(false),[editStatus,setEditStatus]=useState("WAITING");
  const[savingWish,setSavingWish]=useState(false),[wishMsg,setWishMsg]=useState("");
  const[settings,setSettings]=useState<GrabDownloadSettings>({
    quality_required_language:"MULTI",
    quality_preferred_resolution:"1080p",
    quality_preferred_codecs:"H265,x265,HEVC",
    quality_max_size_gb:5,
    quality_allowed_sources:"WEB-DL,WEBRip,BluRay,WEB",
    quality_min_seeders:2,
    c411_categories:"2000,2010,2030,2050,2060,2070,2080,2090,5000,5060,5070,5080",
    c411_request_delay_seconds:4.2,
    transmission_download_dir:"",
    plex_url:"",
    plex_token:"",
    show_force_title_mismatch:false
  });
  const[forceTitleMismatch,setForceTitleMismatch]=useState(false);
  const[discovery,setDiscovery]=useState<DiscoveryLists>(()=>{
    const c=readDiscCache();
    return c?{nouveautes:c.nouveautes,attendus:c.attendus,classiques:c.classiques,nouveautes_source:c.nouveautes_source}:{nouveautes:[],attendus:[],classiques:[],nouveautes_source:"c411"};
  });
  const[discSavedAt,setDiscSavedAt]=useState<number|null>(()=>readDiscCache()?.savedAt||null);
  const[discoveryBusy,setDiscoveryBusy]=useState(false);
  const[discoveryMsg,setDiscoveryMsg]=useState("");
  const[discSettings,setDiscSettings]=useState<DiscoverySettings>({
    min_rating:7,min_votes:40,released_days:60,popularity_days:7,upcoming_days:90,max_results:20,
    auto_add_nouveautes:false,auto_add_attendus:false,auto_add_classiques:false,auto_download:false,
    classic_min_rating:8,classic_min_votes:1500,classic_min_age_years:10
  });
  const[savingDisc,setSavingDisc]=useState(false);
  const[discSettingsMsg,setDiscSettingsMsg]=useState("");
  const[isMobile,setIsMobile]=useState(()=>typeof window!=="undefined"&&window.matchMedia("(max-width: 860px)").matches);

  async function home(){
    const[w,d]=await Promise.all([
      apiFetch(`/wishlist`).then(r=>r.ok?r.json():{items:[]}).catch(()=>({items:[]})),
      apiFetch(`/downloads`).then(r=>r.ok?r.json():{items:[]}).catch(()=>({items:[]}))
    ]);
    setWishlist(w.items||[]);
    setDownloads((d.items||[]).filter((x:any)=>(x.progress??0)<100));
    setDlError(d.error||"");
  }
  async function loadSettings(){
    const r=await apiFetch(`/settings/grab-download`);
    if(!r.ok)return;
    const d=await r.json();
    setSettings(s=>({...s,...d,plex_url:d.plex_url??"",plex_token:d.plex_token??"",show_force_title_mismatch:!!d.show_force_title_mismatch}));
    setForceTitleMismatch(!!d.show_force_title_mismatch);
  }
  function applyDiscovery(d:any){
    const next:DiscoveryLists={
      nouveautes:d.nouveautes||[],
      attendus:d.attendus||[],
      classiques:d.classiques||[],
      nouveautes_source:d.nouveautes_source==="tmdb"?"tmdb":"c411",
    };
    const savedAt=Date.now();
    setDiscovery(next);
    setDiscSavedAt(savedAt);
    writeDiscCache(next, savedAt);
    if(d.settings)setDiscSettings(d.settings);
  }
  async function loadDiscovery(force=false){
    if(!force && readDiscCache()) return;
    setDiscoveryBusy(true);setDiscoveryMsg("");
    try{
      const r=await apiFetch(`/discovery${force?"?refresh=1":""}`);
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:"Impossible de charger les nouveautés");
      applyDiscovery(d);
    }catch(e:any){
      setDiscoveryMsg(e?.message||"Erreur lors du chargement des nouveautés");
    }finally{setDiscoveryBusy(false)}
  }
  async function loadDiscSettings(){
    const r=await apiFetch(`/settings/discovery`);
    if(!r.ok)return;
    setDiscSettings(await r.json());
  }
  useEffect(()=>{home();loadSettings();loadDiscSettings();loadDiscovery(false);const t=setInterval(home,5000);return()=>clearInterval(t)},[]);
  useEffect(()=>{
    const mq=window.matchMedia("(max-width: 860px)");
    const on=()=>setIsMobile(mq.matches);
    mq.addEventListener("change",on);
    return()=>mq.removeEventListener("change",on);
  },[]);
  useEffect(()=>{
    function onWheel(e:WheelEvent){
      const scroller=(e.target as HTMLElement|null)?.closest?.(".h-scroll") as HTMLElement|null;
      if(!scroller)return;
      if(Math.abs(e.deltaY)<=Math.abs(e.deltaX))return;
      scroller.scrollLeft+=e.deltaY;
      e.preventDefault();
    }
    document.addEventListener("wheel",onWheel,{passive:false});
    return()=>document.removeEventListener("wheel",onWheel);
  },[]);

  async function search(){
    if(!q.trim())return;
    setBusy(true);setBusyMsg("Recherche TMDB · bibliothèque · C411…");setSearched(true);setSearchMsg("");setSearchSources(null);setMovie(null);
    try{
      const d=await apiFetch(`/search?q=${encodeURIComponent(q)}`).then(r=>r.json());
      setResults(d.results||[]);
      setSearchMsg(d.message||"");
      setSearchSources(d.sources||null);
    }catch{
      setResults([]);setSearchMsg("Erreur lors de la recherche.");
    }finally{setBusy(false);setBusyMsg("")}
  }
  async function open(x:any){
    if(!x?.tmdb_id){alert("Pas de fiche TMDB pour ce résultat — impossible d'ouvrir le détail.");return}
    const d=await apiFetch(`/movies/${x.tmdb_id}`).then(r=>r.json());
    setMovie({
      ...x,...d,
      vote_average:d.vote_average??x.vote_average,
      vote_count:d.vote_count??x.vote_count,
      popularity:d.popularity??x.popularity,
      release_date:d.release_date??x.release_date,
      overview:d.overview??x.overview,
    });
    setReleases([]);setDlState(null);setC411Tried(false);setC411Msg("");setC411Err(false);
  }
  function c411Fallback(list:any[], message?:string, err=false){
    setReleases(list);
    setC411Tried(true);
    setC411Err(err);
    setC411Msg(list.length?"":(message||"Aucune release trouvée sur C411 pour ce film."));
  }
  async function c411(tmdbId?:number){
    const id=tmdbId??movie?.tmdb_id;
    if(!id)return;
    setBusy(true);setBusyMsg("Recherche C411…");setDlState(null);setC411Tried(false);setC411Msg("");setC411Err(false);
    try{
      const r=await apiFetch(`/movies/${id}/releases`);
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:"Impossible de chercher sur C411");
      c411Fallback(d.results||[], d.message);
    }catch(e:any){
      c411Fallback([], e?.message||"Erreur lors de la recherche C411", true);
    }finally{setBusy(false);setBusyMsg("")}
  }
  async function searchWish(w:any){
    if(!w?.tmdb_id){alert("Pas de fiche TMDB pour cette envie — impossible de chercher sur C411.");return}
    setSearchingWishId(w.id);
    setResults([]);setSearched(false);setReleases([]);setDlState(null);setC411Tried(false);setC411Msg("");setC411Err(false);
    setBusy(true);setBusyMsg("Recherche C411…");
    try{
      const d=await apiFetch(`/movies/${w.tmdb_id}`).then(r=>r.json());
      setMovie(d);
      const r=await apiFetch(`/movies/${w.tmdb_id}/releases`);
      const rel=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(typeof rel.detail==="string"?rel.detail:"Impossible de chercher sur C411");
      c411Fallback(rel.results||[], rel.message);
    }catch(e:any){
      c411Fallback([], e?.message||"Erreur lors de la recherche C411", true);
    }finally{setBusy(false);setBusyMsg("");setSearchingWishId(null)}
  }
  async function wish(auto=false){await apiFetch(`/movies/${movie.tmdb_id}/wishlist?auto_download=${auto}`,{method:"POST"});await home();setMovie(await apiFetch(`/movies/${movie.tmdb_id}`).then(r=>r.json()))}
  function startEditWish(w:any){
    setEditingWishId(w.id);setEditAuto(!!w.auto_download);setEditStatus(w.status||"WAITING");setWishMsg("");
  }
  async function refreshMovie(){
    if(!movie?.tmdb_id)return;
    setMovie(await apiFetch(`/movies/${movie.tmdb_id}`).then(r=>r.json()));
  }
  async function saveWish(id:number){
    setSavingWish(true);setWishMsg("");
    try{
      const payload:any={auto_download:editAuto};
      if(editStatus==="WAITING"||editStatus==="PAUSED") payload.status=editStatus;
      const r=await apiFetch(`/wishlist/${id}`,{
        method:"PUT",body:JSON.stringify(payload)
      });
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:"Impossible de modifier l'envie");
      setEditingWishId(null);await home();await refreshMovie();
    }catch(e:any){setWishMsg(e?.message||"Erreur lors de la modification")}
    finally{setSavingWish(false)}
  }
  async function removeWish(id:number){
    if(!confirm("Retirer cette envie ?"))return;
    setSavingWish(true);setWishMsg("");
    try{
      const r=await apiFetch(`/wishlist/${id}`,{method:"DELETE"});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.detail||"Impossible de retirer l'envie");
      setEditingWishId(null);await home();await refreshMovie();
    }catch(e:any){setWishMsg(e?.message||"Erreur lors de la suppression")}
    finally{setSavingWish(false)}
  }
  async function dl(id:number,force=false,reason?:string){
    if(force && !confirm(`Cette release ne respecte pas vos paramètres${reason?` (${reason})`:""}. Forcer le téléchargement ?`)) return;
    setDlState({id,status:"loading"});
    try{
      const r=await apiFetch(`/releases/${id}/download${force?"?force=true":""}`,{method:"POST"});
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(typeof d.detail==="string"?d.detail:"Impossible d'ajouter à Transmission");
      setDlState({id,status:"ok"});
      await home();
      await refreshMovie();
    }catch(e:any){
      setDlState({id,status:"error",msg:e?.message||"Impossible d'ajouter à Transmission"});
    }
  }
  function goHome(){
    setShowSettings(false);
    setMovie(null);
    setResults([]);
    setReleases([]);
    setDlState(null);
    setC411Tried(false);
    setC411Msg("");
    setC411Err(false);
    setSearched(false);
    setSearchMsg("");
    setSearchSources(null);
    setQ("");
    setEditingWishId(null);
    setWishMsg("");
  }
  async function saveSettings(){
    setSavingSettings(true);setSettingsMsg("");
    try{
      const payload={
        ...settings,
        quality_max_size_gb:Number(settings.quality_max_size_gb),
        quality_min_seeders:Number(settings.quality_min_seeders),
        c411_request_delay_seconds:Number(settings.c411_request_delay_seconds),
      };
      const r=await apiFetch(`/settings/grab-download`,{
        method:"PUT",
        body:JSON.stringify(payload),
      });
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.detail||"Impossible de sauvegarder");
      const saved=d.settings||settings;
      setSettings(saved);
      setForceTitleMismatch(!!saved.show_force_title_mismatch);
      setSettingsMsg("Paramètres enregistrés.");
    }catch(e:any){
      setSettingsMsg(e?.message||"Erreur lors de l'enregistrement");
    }finally{setSavingSettings(false)}
  }
  async function saveDiscSettings(){
    setSavingDisc(true);setDiscSettingsMsg("");
    try{
      const payload={
        ...discSettings,
        min_rating:Number(discSettings.min_rating),
        min_votes:Number(discSettings.min_votes),
        released_days:Number(discSettings.released_days),
        popularity_days:Number(discSettings.popularity_days),
        upcoming_days:Number(discSettings.upcoming_days),
        max_results:Number(discSettings.max_results),
        classic_min_rating:Number(discSettings.classic_min_rating),
        classic_min_votes:Number(discSettings.classic_min_votes),
        classic_min_age_years:Number(discSettings.classic_min_age_years),
      };
      const r=await apiFetch(`/settings/discovery`,{method:"PUT",body:JSON.stringify(payload)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:"Impossible de sauvegarder");
      setDiscSettings(d.settings||discSettings);
      if(d.applied?.error) setDiscSettingsMsg(`Paramètres enregistrés, mais l'ajout auto a échoué : ${d.applied.error}`);
      else {
        const added=d.applied?.added||0;
        setDiscSettingsMsg(added?`Paramètres enregistrés. ${added} film(s) ajouté(s) aux envies.`:"Paramètres enregistrés.");
      }
      await loadDiscovery(true);
      await home();
    }catch(e:any){
      setDiscSettingsMsg(e?.message||"Erreur lors de l'enregistrement");
    }finally{setSavingDisc(false)}
  }
  async function setPopularityPeriod(days:number){
    if(Number(discSettings.popularity_days)===days||discoveryBusy||savingDisc) return;
    const prev=discSettings.popularity_days;
    setDiscoveryMsg("");
    setDiscoveryBusy(true);
    setDiscSettings(s=>({...s,popularity_days:days}));
    try{
      const r=await apiFetch(`/settings/discovery`,{method:"PUT",body:JSON.stringify({popularity_days:days})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:"Impossible de changer la période");
      if(d.settings)setDiscSettings(d.settings);
      await loadDiscovery(true);
    }catch(e:any){
      setDiscSettings(s=>({...s,popularity_days:prev}));
      setDiscoveryBusy(false);
      setDiscoveryMsg(e?.message||"Impossible de changer la période");
    }
  }
  async function ignoreDisc(tmdbId:number){
    const r=await apiFetch(`/discovery/${tmdbId}/ignore`,{method:"POST"});
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      alert(typeof d.detail==="string"?d.detail:"Impossible de masquer ce film");
      return;
    }
    setDiscovery(prev=>{
      const next={
        nouveautes:prev.nouveautes.filter((x:any)=>x.tmdb_id!==tmdbId),
        attendus:prev.attendus.filter((x:any)=>x.tmdb_id!==tmdbId),
        classiques:(prev.classiques||[]).filter((x:any)=>x.tmdb_id!==tmdbId),
        nouveautes_source:prev.nouveautes_source,
      };
      writeDiscCache(next, discSavedAt||Date.now());
      return next;
    });
  }

  function wishForm(id:number){
    return <div className="wish-edit">
      <label className="check"><input type="checkbox" checked={editAuto} onChange={e=>setEditAuto(e.target.checked)}/>Téléchargement auto</label>
      <label>Statut
        <select value={editStatus} onChange={e=>setEditStatus(e.target.value)}>
          <option value="WAITING">En attente</option>
          <option value="PAUSED">En pause</option>
          {editStatus!=="WAITING"&&editStatus!=="PAUSED"&&<option value={editStatus}>{WISH_STATUS[editStatus]||editStatus}</option>}
        </select>
      </label>
      <div className="actions">
        <button onClick={()=>saveWish(id)} disabled={savingWish}>{savingWish?"Enregistrement...":"Enregistrer"}</button>
        <button className="ghost" onClick={()=>{setEditingWishId(null);setWishMsg("")}} disabled={savingWish}>Annuler</button>
        <button className="ghost danger" onClick={()=>removeWish(id)} disabled={savingWish}>Retirer</button>
      </div>
      {wishMsg&&<p className="muted">{wishMsg}</p>}
    </div>;
  }

  function discCard(x:any){
    const grabs=Number(x.c411_grabs)||0;
    return <div className="card tile" key={x.tmdb_id} onClick={()=>open(x)} title={x.title}>
      <Poster path={x.poster_path} w={342} className="poster tile-poster"/>
      {grabs>0&&<span className="tile-grabs" title={`${grabs.toLocaleString("fr-FR")} complétés sur C411`}>{fmtGrabs(grabs)}</span>}
      <button className="ghost tile-hide" onClick={e=>{e.stopPropagation();ignoreDisc(x.tmdb_id)}}>Masquer</button>
    </div>;
  }
  function board(area:string, title:string, count:number, extra:React.ReactNode, body:React.ReactNode, subtitle?:string){
    return <section className={`board ${area}`}>
      <div className="board-head">
        <div className="board-title">
          <h2>{title} <span className="count">{count}</span></h2>
          {subtitle?<p className="board-sub">{subtitle}</p>:null}
        </div>
        {extra}
      </div>
      {body}
    </section>;
  }
  function rail(items:any[], empty:string, children:React.ReactNode){
    return items.length===0?<p className="empty-state">{empty}</p>:<div className="h-scroll">{children}</div>;
  }
  function resultCard(x:any, i:number){
    const st=x.owned?{kind:"ok",label:"En stock"}
      :dlTmdbIds.has(x.tmdb_id)?{kind:"downloading",label:"En cours"}
      :wishTmdbIds.has(x.tmdb_id)?{kind:"waiting",label:"Envie"}
      :null;
    const label=[x.title,x.year].filter(Boolean).join(" · ");
    return <button
      className={`result-card ${x.tmdb_id?"":"disabled"}`}
      key={x.tmdb_id||`${x.title}-${x.year}-${i}`}
      onClick={()=>open(x)}
      disabled={!x.tmdb_id}
      title={x.tmdb_id?label:`${label} — pas de fiche TMDB`}
      aria-label={x.tmdb_id?label:`${label || "Résultat"}, pas de fiche TMDB`}
    >
      <span className="result-poster">
        <Poster path={x.poster_path} w={342} className="poster tile-poster"/>
        {!x.poster_path&&<span className="result-fallback" aria-hidden>{(x.title||"?")[0]}</span>}
        {st&&<span className={`badge ${st.kind} result-badge`}>{st.label}</span>}
      </span>
      <span className="result-meta">
        <b>{x.title||"Sans titre"}</b>
        <small>{x.year||"—"}</small>
      </span>
    </button>;
  }
  const wishTmdbIds=new Set(wishlist.map((w:any)=>w.tmdb_id).filter(Boolean));
  const dlTmdbIds=new Set(downloads.map((d:any)=>d.tmdb_id).filter(Boolean));
  const hiddenDiscIds=new Set([...wishTmdbIds,...dlTmdbIds]);
  if(movie?.tmdb_id && (movie.owned||movie.wishlist)) hiddenDiscIds.add(movie.tmdb_id);
  const discNouveautes=discovery.nouveautes.filter((x:any)=>!x.wishlist&&!x.owned&&!hiddenDiscIds.has(x.tmdb_id));
  const discAttendus=discovery.attendus.filter((x:any)=>!x.wishlist&&!x.owned&&!hiddenDiscIds.has(x.tmdb_id));
  const discClassiques=(discovery.classiques||[]).filter((x:any)=>!x.wishlist&&!x.owned&&!hiddenDiscIds.has(x.tmdb_id));

  const showResults=searched;
  function closeMovie(){setMovie(null);setDlState(null);setReleases([]);setC411Tried(false);setC411Msg("");setC411Err(false)}
  function clearSearch(){setSearched(false);setResults([]);setSearchMsg("");setSearchSources(null)}
  useEffect(()=>{
    function onKey(e:KeyboardEvent){
      if(e.key!=="Escape")return;
      if(movie){closeMovie();return}
      if(showSettings){setShowSettings(false);return}
      if(searched) clearSearch();
    }
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[movie,showSettings,searched]);
  useEffect(()=>{
    if(!movie&&!showSettings&&!(searched&&isMobile))return;
    const prev=document.body.style.overflow;
    document.body.style.overflow="hidden";
    return()=>{document.body.style.overflow=prev};
  },[movie,showSettings,searched,isMobile]);

  return <div className="app">
    <header className="topbar">
      <a href="/" className="brand-home" onClick={e=>{e.preventDefault();goHome()}} title="Retour à l'accueil">
        <Brand tagline="Bibliothèque · C411 · Transmission"/>
      </a>
      <div className="search">
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()} placeholder="Rechercher un film…"/>
        {busy&&<span className="spinner" aria-hidden="true"/>}
        <button onClick={search} disabled={busy||!q.trim()}>Rechercher</button>
      </div>
      <div className="actions">
        <button className="ghost" onClick={()=>setShowSettings(x=>!x)}>{showSettings?"Fermer":"Paramètres"}</button>
        {authRequired&&<button className="ghost" onClick={async()=>{await apiFetch(`/auth/logout`,{method:"POST"});onLogout()}}>Déconnexion</button>}
      </div>
    </header>
    {(busy||(!busy&&searched&&(searchMsg||searchSources)))&&<div className={`status-bar ${!busy&&searched&&!results.length?"warn":""} ${searched&&isMobile?"mobile-hidden":""}`}>
      {busy&&<><span className="spinner" aria-hidden="true"/><span>{busyMsg||"Recherche…"}</span></>}
      {!busy&&searched&&searchMsg&&<span>{searchMsg}</span>}
      {!busy&&searched&&searchSources&&results.length>0&&<span className="muted">Sources : TMDB {searchSources.tmdb||0} · Local {searchSources.local||0} · C411 {searchSources.c411||0}</span>}
    </div>}
    <div className="page">
      <div className="workspace">
        <div className="col-main">
          {showResults&&!isMobile&&board("board-results","Résultats",results.length,
            <button className="ghost" onClick={clearSearch}>Retour</button>,
            results.length===0?<p className="empty-state">{busy?"Recherche en cours…":(searchMsg||"Aucun résultat pour cette recherche.")}</p>:
            <div className="results-grid">{results.map(resultCard)}</div>,
            q.trim()?`pour « ${q.trim()} »`:undefined
          )}
          {(!showResults||isMobile)&&board("board-nouv","Nouveautés",discNouveautes.length,
            <div className="board-tools">
              <div className="period-switch" role="group" aria-label="Période de popularité">
                {POP_PERIODS.map(([days,label])=><button key={days} className={`ghost ${Number(discSettings.popularity_days)===days?"on":""}`} onClick={()=>setPopularityPeriod(days)} disabled={discoveryBusy||savingDisc}>{label}</button>)}
              </div>
              <button className="ghost" onClick={()=>loadDiscovery(true)} disabled={discoveryBusy}>{discoveryBusy?"Chargement…":"Actualiser"}</button>
            </div>,
            <>
              {discoveryMsg&&<p className="empty-msg">{discoveryMsg}</p>}
              {rail(discNouveautes,discoveryBusy?"Chargement des films les plus complétés sur C411…":(discovery.nouveautes_source==="tmdb"?"Aucun film récent bien noté hors stock, envies et téléchargements. C411 n'a pas répondu : repli sur la note TMDB.":`Aucun film très complété sur C411 sur ${popPeriodLabel(discSettings.popularity_days)}, hors stock, envies et téléchargements.`),discNouveautes.map(discCard))}
            </>,
            discSavedAt
              ?`${discovery.nouveautes_source==="tmdb"?"Note TMDB":`Popularité C411 · ${popPeriodLabel(discSettings.popularity_days)}`} · ${fmtWhen(discSavedAt)}`
              :`Popularité C411 · ${popPeriodLabel(discSettings.popularity_days)}`
          )}
          {(!showResults||isMobile)&&board("board-attend","Attendus",discAttendus.length,null,
            rail(discAttendus,discoveryBusy?"Chargement…":"Aucune sortie à venir dans la fenêtre choisie.",discAttendus.map(discCard))
          )}
          {(!showResults||isMobile)&&board("board-class","Classiques",discClassiques.length,null,
            rail(discClassiques,discoveryBusy?"Chargement…":"Aucun classique ultra bien noté absent de la bibliothèque Plex, des envies et des téléchargements.",discClassiques.map(discCard))
          )}
        </div>
        <div className="col-side">
          {board("board-wish","Envies",wishlist.length,null,
            wishlist.length===0?<p className="empty-state">Aucune envie pour le moment. Recherchez un film pour en ajouter une.</p>:
            <div className="side-list">{wishlist.map(w=>{
              const editing=editingWishId===w.id;
              return <div className={`card list-item wish-item ${editing?"editing":""}`} key={w.id} onClick={()=>{if(!editing&&w.tmdb_id)open(w)}}>
                <div className="list-item-head">
                  <Poster path={w.poster_path}/>
                  <span className="meta">
                    <b>{w.title}</b>
                    <small>{w.year||"?"}</small>
                    <span className="meta-row">
                      <span className={`badge ${statusKind(w.status)}`}>{WISH_STATUS[w.status]||w.status}</span>
                      {w.auto_download&&<span className="badge auto">Auto</span>}
                    </span>
                  </span>
                  {!editing&&<div className="actions">
                    <button onClick={e=>{e.stopPropagation();searchWish(w)}} disabled={busy||!w.tmdb_id} title="Chercher maintenant sur C411">{searchingWishId===w.id?"Recherche…":"Rechercher"}</button>
                    <button className="ghost" onClick={e=>{e.stopPropagation();startEditWish(w)}}>Modifier</button>
                  </div>}
                </div>
                {editing&&<div onClick={e=>e.stopPropagation()}>{wishForm(w.id)}</div>}
              </div>;
            })}</div>
          )}
          {board("board-dl","Téléchargements",downloads.length,null,
            dlError?<p className="empty-msg">{dlError}</p>:downloads.length===0?<p className="empty-state">Aucun téléchargement en cours.</p>:
            <div className="side-list">{downloads.map(d=><div className="card list-item dl-item" key={d.hash||d.id}>
              <div className="list-item-head">
                <span className="meta"><b>{d.title}</b><small>{d.status} · {rate(d.rate_download)} · {eta(d.eta)}{d.name&&d.name!==d.title?` · ${d.name}`:""}</small>{d.error&&<em>{d.error}</em>}</span>
                <span className="dl-pct">{d.progress}%</span>
              </div>
              <div className="bar"><i style={{width:`${Math.min(100,d.progress||0)}%`}}/></div>
            </div>)}</div>
          )}
        </div>
      </div>

      {showResults&&isMobile&&<div className="scrim search-scrim" onClick={clearSearch}>
        <section className="panel sheet search-sheet" onClick={e=>e.stopPropagation()}>
          <div className="sheet-handle" aria-hidden="true"/>
          <div className="sheet-head">
            <div className="board-title">
              <h2>Résultats <span className="count">{results.length}</span></h2>
              {q.trim()?<p className="board-sub">pour « {q.trim()} »</p>:null}
            </div>
            <button className="ghost" onClick={clearSearch}>Fermer</button>
          </div>
          {busy&&<p className="busy search-sheet-msg"><span className="spinner" aria-hidden="true"/><span>{busyMsg||"Recherche…"}</span></p>}
          {!busy&&searchSources&&results.length>0&&<p className="muted search-sheet-msg">TMDB {searchSources.tmdb||0} · Local {searchSources.local||0} · C411 {searchSources.c411||0}</p>}
          {results.length===0
            ?<p className="empty-state">{busy?"Recherche en cours…":(searchMsg||"Aucun résultat pour cette recherche.")}</p>
            :<div className="results-rail h-scroll">{results.map(resultCard)}</div>}
        </section>
      </div>}

      {showSettings&&<div className="scrim settings-scrim" onClick={()=>setShowSettings(false)}>
        <section className="panel sheet" onClick={e=>e.stopPropagation()}>
          <div className="sheet-head"><h2>Paramètres de téléchargement</h2><button className="ghost" onClick={()=>setShowSettings(false)}>Fermer</button></div>
          <div className="settings-grid">
            <label>Langue requise<input value={settings.quality_required_language} onChange={e=>setSettings({...settings,quality_required_language:e.target.value})}/></label>
            <label>Résolution préférée<input value={settings.quality_preferred_resolution} onChange={e=>setSettings({...settings,quality_preferred_resolution:e.target.value})}/></label>
            <label>Codecs préférés (csv)<input value={settings.quality_preferred_codecs} onChange={e=>setSettings({...settings,quality_preferred_codecs:e.target.value})}/></label>
            <label>Sources autorisées (csv)<input value={settings.quality_allowed_sources} onChange={e=>setSettings({...settings,quality_allowed_sources:e.target.value})}/></label>
            <label>Taille max (Go)<input type="number" step="0.1" min="0.1" value={settings.quality_max_size_gb} onChange={e=>setSettings({...settings,quality_max_size_gb:Number(e.target.value)})}/></label>
            <label>Seeders minimum<input type="number" min="0" value={settings.quality_min_seeders} onChange={e=>setSettings({...settings,quality_min_seeders:Number(e.target.value)})}/></label>
            <label>Catégories C411 (csv)<input value={settings.c411_categories} onChange={e=>setSettings({...settings,c411_categories:e.target.value})}/></label>
            <label>Délai C411 (secondes)<input type="number" step="0.1" min="0" value={settings.c411_request_delay_seconds} onChange={e=>setSettings({...settings,c411_request_delay_seconds:Number(e.target.value)})}/></label>
            <label className="full">Dossier de téléchargement Transmission<input value={settings.transmission_download_dir} onChange={e=>setSettings({...settings,transmission_download_dir:e.target.value})}/></label>
            <label className="full">URL Plex<input value={settings.plex_url||""} onChange={e=>setSettings({...settings,plex_url:e.target.value})} placeholder="http://192.168.1.10:32400"/></label>
            <label className="full">Jeton Plex<input type="password" value={settings.plex_token||""} onChange={e=>setSettings({...settings,plex_token:e.target.value})} placeholder="X-Plex-Token" autoComplete="off"/></label>
            <label className="check full"><input type="checkbox" checked={!!settings.show_force_title_mismatch} onChange={e=>setSettings({...settings,show_force_title_mismatch:e.target.checked})}/>Afficher le bouton de forcer le téléchargement malgré une différence de nom</label>
          </div>
          <div className="actions"><button onClick={saveSettings} disabled={savingSettings}>{savingSettings?"Enregistrement...":"Enregistrer"}</button>{settingsMsg&&<p className="muted">{settingsMsg}</p>}</div>
          <h2>Nouveautés, attendus et classiques</h2>
          <p className="muted settings-hint">Les nouveautés reprennent le top Film de C411 sur la période choisie (24 h, 7 j ou 30 j) : les torrents publiés dans ce laps de temps, classés par nombre de complétions. La note et les votes servent de repli si C411 ne répond pas, et pour filtrer les attendus. Les classiques restent les films anciens très bien notés, absents de la bibliothèque Plex. Tout film déjà en stock, en envie ou en téléchargement est masqué. L'ajout auto n'est fait qu'une fois par film.</p>
          <div className="settings-grid">
            <label>Période de popularité
              <select value={discSettings.popularity_days} onChange={e=>setDiscSettings({...discSettings,popularity_days:Number(e.target.value)})}>
                {POP_PERIODS.map(([days,label])=><option key={days} value={days}>{label}</option>)}
              </select>
            </label>
            <label>Note minimale TMDB<input type="number" step="0.1" min="0" max="10" value={discSettings.min_rating} onChange={e=>setDiscSettings({...discSettings,min_rating:Number(e.target.value)})}/></label>
            <label>Votes minimum<input type="number" min="0" value={discSettings.min_votes} onChange={e=>setDiscSettings({...discSettings,min_votes:Number(e.target.value)})}/></label>
            <label>Fenêtre nouveautés (jours)<input type="number" min="1" max="365" value={discSettings.released_days} onChange={e=>setDiscSettings({...discSettings,released_days:Number(e.target.value)})}/></label>
            <label>Fenêtre attendus (jours)<input type="number" min="1" max="365" value={discSettings.upcoming_days} onChange={e=>setDiscSettings({...discSettings,upcoming_days:Number(e.target.value)})}/></label>
            <label>Nombre max par liste<input type="number" min="1" max="50" value={discSettings.max_results} onChange={e=>setDiscSettings({...discSettings,max_results:Number(e.target.value)})}/></label>
            <label>Note minimale classiques<input type="number" step="0.1" min="0" max="10" value={discSettings.classic_min_rating} onChange={e=>setDiscSettings({...discSettings,classic_min_rating:Number(e.target.value)})}/></label>
            <label>Votes minimum (classiques)<input type="number" min="0" value={discSettings.classic_min_votes} onChange={e=>setDiscSettings({...discSettings,classic_min_votes:Number(e.target.value)})}/></label>
            <label>Âge minimum classiques (années)<input type="number" min="1" max="80" value={discSettings.classic_min_age_years} onChange={e=>setDiscSettings({...discSettings,classic_min_age_years:Number(e.target.value)})}/></label>
            <label className="check full"><input type="checkbox" checked={discSettings.auto_add_nouveautes} onChange={e=>setDiscSettings({...discSettings,auto_add_nouveautes:e.target.checked})}/>Ajouter automatiquement les nouveautés aux envies</label>
            <label className="check full"><input type="checkbox" checked={discSettings.auto_add_attendus} onChange={e=>setDiscSettings({...discSettings,auto_add_attendus:e.target.checked})}/>Ajouter automatiquement les attendus aux envies</label>
            <label className="check full"><input type="checkbox" checked={discSettings.auto_add_classiques} onChange={e=>setDiscSettings({...discSettings,auto_add_classiques:e.target.checked})}/>Ajouter automatiquement les classiques aux envies</label>
            <label className="check full"><input type="checkbox" checked={discSettings.auto_download} onChange={e=>setDiscSettings({...discSettings,auto_download:e.target.checked})} disabled={!discSettings.auto_add_nouveautes&&!discSettings.auto_add_attendus&&!discSettings.auto_add_classiques}/>Téléchargement auto pour ces ajouts</label>
          </div>
          <div className="actions"><button onClick={saveDiscSettings} disabled={savingDisc}>{savingDisc?"Enregistrement...":"Enregistrer"}</button>{discSettingsMsg&&<p className="muted">{discSettingsMsg}</p>}</div>
        </section>
      </div>}

      {movie&&<div className="scrim movie-scrim" onClick={closeMovie}>
        <section className="panel sheet movie-sheet" id="movie-panel" onClick={e=>e.stopPropagation()}>
          <div className="sheet-handle" aria-hidden="true"/>
          <div className="movie-head">
            <div className="movie-head-row">
              <Poster path={movie.poster_path} w={342} className="poster lg"/>
              <div className="grow">
                <div className="row movie-title-row">
                  <div>
                    <h2>{movie.title}</h2>
                    <p className="muted">{[movie.year,movie.release_date&&fmtDate(movie.release_date)].filter(Boolean).join(" · ")}</p>
                  </div>
                  <button className="ghost" onClick={closeMovie}>Fermer</button>
                </div>
                <p className="status-line">
                  {movie.vote_average?<span className="badge auto">★ {movie.vote_average}{movie.vote_count?` · ${movie.vote_count} votes`:""}</span>:null}
                  {movie.c411_grabs?<span className="badge auto">{Number(movie.c411_grabs).toLocaleString("fr-FR")} complétés</span>:null}
                  {movie.popularity?<span className="badge missing">Popularité {Math.round(Number(movie.popularity))}</span>:null}
                  {movie.owned?<span className="badge ok">Présent dans la bibliothèque</span>
                  :movie.wishlist?<><span className={`badge ${statusKind(movie.wishlist.status)}`}>{WISH_STATUS[movie.wishlist.status]||movie.wishlist.status}</span>{movie.wishlist.auto_download&&<span className="badge auto">Auto</span>}</>
                  :<span className="badge missing">Absent</span>}
                </p>
              </div>
            </div>
            {movie.overview?<p className="muted movie-overview">{movie.overview}</p>:null}
            {movie.owned?<div className="actions">
              {(movie.plex_url||plexFallback(movie.title,movie.year))&&<a className="plex-link" href={movie.plex_url||plexFallback(movie.title,movie.year)} target="_blank" rel="noopener noreferrer">Ouvrir dans Plex</a>}
            </div>:
            movie.wishlist?<div>
              <div className="actions">
                <button onClick={()=>c411()} disabled={busy}>Chercher sur C411</button>
                {editingWishId!==movie.wishlist.id&&<button className="ghost" onClick={()=>startEditWish(movie.wishlist)}>Modifier l'envie</button>}
                <button className="ghost danger" onClick={()=>removeWish(movie.wishlist.id)} disabled={savingWish}>Retirer</button>
              </div>
              {editingWishId===movie.wishlist.id&&wishForm(movie.wishlist.id)}
            </div>:
            <div className="actions">
              <button onClick={()=>c411()} disabled={busy}>Chercher sur C411</button>
              <button className="ghost" onClick={()=>wish(false)}>Ajouter aux envies</button>
              <button className="ghost" onClick={()=>wish(true)}>Téléchargement auto</button>
              <button className="ghost" onClick={()=>{ignoreDisc(movie.tmdb_id);closeMovie()}}>Masquer</button>
            </div>}
          </div>
          <div className="movie-body">
            {busy&&<p className="busy"><span className="spinner" aria-hidden="true"/><span>{busyMsg||"Recherche C411…"}</span></p>}
            {movie.owned&&<div className="file-list">{(movie.local_files||[]).map((f:any)=><div className="subcard" key={f.path}>{f.filename}<small>{size(f.size_bytes)} · {f.resolution} · {f.codec} · {f.language}</small></div>)}</div>}
            {c411Tried&&!busy&&releases.length===0&&<div className={`c411-fallback ${c411Err?"warn":""}`}>
              <p>{c411Msg||"Aucune release trouvée sur C411 pour ce film."}</p>
              {!c411Err&&!movie.owned&&(movie.wishlist
                ?<p className="muted">La recherche automatique réessaiera plus tard.</p>
                :<p className="muted">Ajoutez-le aux envies pour relancer la recherche plus tard.</p>)}
            </div>}
            {releases.length>0&&<>
              <h3 className="release-heading">C411 <span className="count">{releases.length}</span></h3>
              <div className="release-list">{releases.map(r=>{
                const thisDl=dlState?.id===r.id?dlState:null;
                const loading=thisDl?.status==="loading";
                const added=thisDl?.status==="ok";
                const failed=thisDl?.status==="error";
                const otherBusy=dlState?.status==="loading"&&dlState.id!==r.id;
                return <div className={`release ${r.accepted?"accepted":"rejected"}`} key={r.id}>
                  <div className="release-info">
                    <b>{r.title}</b>
                    <small>{size(r.size_bytes)} · S:{r.seeders} · {r.resolution} · {r.codec} · score {r.score}</small>
                    {!r.accepted&&<em>{r.rejection_reason}</em>}
                    {failed&&<em>{thisDl?.msg||"Erreur"}</em>}
                  </div>
                  <div className="release-action">
                    {added?<p className="dl-ok"><span className="check-ok" aria-hidden="true"/>Ajouté</p>
                    :loading?<button disabled className="btn-busy"><span className="spinner" aria-hidden="true"/>Ajout…</button>
                    :r.accepted?<button onClick={()=>dl(r.id)} disabled={otherBusy}>Télécharger</button>
                    :(r.tmdb_match!==false||forceTitleMismatch)?<button className="ghost" onClick={()=>dl(r.id,true,r.rejection_reason)} disabled={otherBusy}>Forcer</button>
                    :null}
                  </div>
                </div>;
              })}</div>
            </>}
          </div>
        </section>
      </div>}
    </div>
  </div>
}
function Root(){
  const[auth,setAuth]=useState<"loading"|"anon"|"ok">("loading");
  const[authRequired,setAuthRequired]=useState(true);
  useEffect(()=>{
    setOnUnauthorized(()=>setAuth("anon"));
    fetch(`${API}/auth/me`,{credentials:"include",signal:AbortSignal.timeout(8000)})
      .then(async r=>{
        if(!r.ok){setAuth("anon");return}
        const d=await r.json().catch(()=>({}));
        setAuthRequired(d.enabled!==false);
        setAuth("ok");
      })
      .catch(()=>setAuth("anon"));
  },[]);
  if(auth==="loading") return <div className="loading-wrap"><p className="busy"><span className="spinner" aria-hidden="true"/><span>Chargement…</span></p></div>;
  if(auth==="anon") return <Login onOk={()=>setAuth("ok")}/>;
  return <App onLogout={()=>setAuth("anon")} authRequired={authRequired}/>;
}
createRoot(document.getElementById("root")!).render(<Root/>);
