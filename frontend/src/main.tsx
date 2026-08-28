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
};

type DiscoverySettings={
  min_rating:number;
  min_votes:number;
  released_days:number;
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
    transmission_download_dir:""
  });
  const[discovery,setDiscovery]=useState<{nouveautes:any[];attendus:any[];classiques:any[]}>({nouveautes:[],attendus:[],classiques:[]});
  const[discoveryBusy,setDiscoveryBusy]=useState(false);
  const[discoveryMsg,setDiscoveryMsg]=useState("");
  const[discSettings,setDiscSettings]=useState<DiscoverySettings>({
    min_rating:7,min_votes:40,released_days:60,upcoming_days:90,max_results:20,
    auto_add_nouveautes:false,auto_add_attendus:false,auto_add_classiques:false,auto_download:false,
    classic_min_rating:8,classic_min_votes:1500,classic_min_age_years:10
  });
  const[savingDisc,setSavingDisc]=useState(false);
  const[discSettingsMsg,setDiscSettingsMsg]=useState("");

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
    setSettings(await r.json());
  }
  async function loadDiscovery(){
    setDiscoveryBusy(true);setDiscoveryMsg("");
    try{
      const r=await apiFetch(`/discovery`);
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:"Impossible de charger les nouveautés");
      setDiscovery({nouveautes:d.nouveautes||[],attendus:d.attendus||[],classiques:d.classiques||[]});
      if(d.settings)setDiscSettings(d.settings);
    }catch(e:any){
      setDiscoveryMsg(e?.message||"Erreur lors du chargement des nouveautés");
    }finally{setDiscoveryBusy(false)}
  }
  async function loadDiscSettings(){
    const r=await apiFetch(`/settings/discovery`);
    if(!r.ok)return;
    setDiscSettings(await r.json());
  }
  useEffect(()=>{home();loadSettings();loadDiscSettings();loadDiscovery();const t=setInterval(home,5000);return()=>clearInterval(t)},[]);
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
  async function wish(auto=false){await apiFetch(`/movies/${movie.tmdb_id}/wishlist?auto_download=${auto}`,{method:"POST"});await home();setMovie(await apiFetch(`/movies/${movie.tmdb_id}`).then(r=>r.json()));loadDiscovery()}
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
      setEditingWishId(null);await home();await refreshMovie();loadDiscovery();
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
      setEditingWishId(null);await home();await refreshMovie();loadDiscovery();
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
      loadDiscovery();
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
      setSettings(d.settings||settings);
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
      await loadDiscovery();
      await home();
    }catch(e:any){
      setDiscSettingsMsg(e?.message||"Erreur lors de l'enregistrement");
    }finally{setSavingDisc(false)}
  }
  async function ignoreDisc(tmdbId:number){
    const r=await apiFetch(`/discovery/${tmdbId}/ignore`,{method:"POST"});
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      alert(typeof d.detail==="string"?d.detail:"Impossible de masquer ce film");
      return;
    }
    setDiscovery(prev=>({
      nouveautes:prev.nouveautes.filter((x:any)=>x.tmdb_id!==tmdbId),
      attendus:prev.attendus.filter((x:any)=>x.tmdb_id!==tmdbId),
      classiques:(prev.classiques||[]).filter((x:any)=>x.tmdb_id!==tmdbId),
    }));
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
    return <div className="card tile" key={x.tmdb_id} onClick={()=>open(x)} title={x.title}>
      <Poster path={x.poster_path} w={342} className="poster tile-poster"/>
      <button className="ghost tile-hide" onClick={e=>{e.stopPropagation();ignoreDisc(x.tmdb_id)}}>Masquer</button>
    </div>;
  }
  function board(area:string, title:string, count:number, extra:React.ReactNode, body:React.ReactNode){
    return <section className={`board ${area}`}>
      <div className="board-head">
        <h2>{title} <span className="count">{count}</span></h2>
        {extra}
      </div>
      {body}
    </section>;
  }
  function rail(items:any[], empty:string, children:React.ReactNode){
    return items.length===0?<p className="empty-state">{empty}</p>:<div className="h-scroll">{children}</div>;
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
    {(busy||(!busy&&searched&&(searchMsg||searchSources)))&&<div className={`status-bar ${!busy&&searched&&!results.length?"warn":""}`}>
      {busy&&<><span className="spinner" aria-hidden="true"/><span>{busyMsg||"Recherche…"}</span></>}
      {!busy&&searched&&searchMsg&&<span>{searchMsg}</span>}
      {!busy&&searched&&searchSources&&results.length>0&&<span className="muted">Sources : TMDB {searchSources.tmdb||0} · Local {searchSources.local||0} · C411 {searchSources.c411||0}</span>}
    </div>}
    <div className="page">
      <div className="workspace">
        <div className="col-main">
          {showResults&&board("board-results","Résultats",results.length,
            <button className="ghost" onClick={()=>{setSearched(false);setResults([]);setSearchMsg("");setSearchSources(null)}}>Retour</button>,
            rail(results,searchMsg||"Aucun résultat pour cette recherche.",results.map((x,i)=><button className={`card tile ${x.tmdb_id?"":"disabled"}`} key={x.tmdb_id||`${x.title}-${x.year}-${i}`} onClick={()=>open(x)} disabled={!x.tmdb_id} title={x.title}>
              <Poster path={x.poster_path} w={342} className="poster tile-poster"/>
            </button>))
          )}
          {!showResults&&board("board-nouv","Nouveautés",discNouveautes.length,
            <button className="ghost" onClick={loadDiscovery} disabled={discoveryBusy}>{discoveryBusy?"Chargement…":"Actualiser"}</button>,
            <>
              {discoveryMsg&&<p className="empty-msg">{discoveryMsg}</p>}
              {rail(discNouveautes,discoveryBusy?"Chargement TMDB…":"Aucun film récent bien noté hors stock, envies et téléchargements.",discNouveautes.map(discCard))}
            </>
          )}
          {!showResults&&board("board-attend","Attendus",discAttendus.length,null,
            rail(discAttendus,discoveryBusy?"Chargement…":"Aucune sortie à venir dans la fenêtre choisie.",discAttendus.map(discCard))
          )}
          {!showResults&&board("board-class","Classiques",discClassiques.length,null,
            rail(discClassiques,discoveryBusy?"Chargement…":"Aucun classique ultra bien noté hors stock, envies et téléchargements.",discClassiques.map(discCard))
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
          </div>
          <div className="actions"><button onClick={saveSettings} disabled={savingSettings}>{savingSettings?"Enregistrement...":"Enregistrer"}</button>{settingsMsg&&<p className="muted">{settingsMsg}</p>}</div>
          <h2>Nouveautés, attendus et classiques</h2>
          <p className="muted settings-hint">Films récents bien notés, sorties à venir, et classiques ultra bien notés, absents de la bibliothèque, des envies et des téléchargements. L'ajout auto n'est fait qu'une fois par film.</p>
          <div className="settings-grid">
            <label>Note minimale TMDB<input type="number" step="0.1" min="0" max="10" value={discSettings.min_rating} onChange={e=>setDiscSettings({...discSettings,min_rating:Number(e.target.value)})}/></label>
            <label>Votes minimum (nouveautés)<input type="number" min="0" value={discSettings.min_votes} onChange={e=>setDiscSettings({...discSettings,min_votes:Number(e.target.value)})}/></label>
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

      {movie&&<div className="scrim" onClick={closeMovie}>
        <section className="panel sheet movie-sheet" id="movie-panel" onClick={e=>e.stopPropagation()}>
          <div className="row detail">
            <Poster path={movie.poster_path} w={342} className="poster lg"/>
            <div className="grow">
              <div className="row"><div>
                <h2>{movie.title}</h2>
                <p className="muted">{[movie.year,movie.release_date&&fmtDate(movie.release_date)].filter(Boolean).join(" · ")}</p>
              </div><button className="ghost" onClick={closeMovie}>Fermer</button></div>
              <p className="status-line">
                {movie.vote_average?<span className="badge auto">★ {movie.vote_average}{movie.vote_count?` · ${movie.vote_count} votes`:""}</span>:null}
                {movie.popularity?<span className="badge missing">Popularité {Math.round(Number(movie.popularity))}</span>:null}
                {movie.owned?<span className="badge ok">Présent dans la bibliothèque</span>
                :movie.wishlist?<><span className={`badge ${statusKind(movie.wishlist.status)}`}>{WISH_STATUS[movie.wishlist.status]||movie.wishlist.status}</span>{movie.wishlist.auto_download&&<span className="badge auto">Auto</span>}</>
                :<span className="badge missing">Absent</span>}
              </p>
              {movie.overview?<p className="muted movie-overview">{movie.overview}</p>:null}
              {movie.owned?<div>{movie.local_files.map((f:any)=><div className="subcard" key={f.path}>{f.filename}<small>{size(f.size_bytes)} · {f.resolution} · {f.codec} · {f.language}</small></div>)}</div>:
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
              {c411Tried&&!busy&&releases.length===0&&<div className={`c411-fallback ${c411Err?"warn":""}`}>
                <p>{c411Msg||"Aucune release trouvée sur C411 pour ce film."}</p>
                {!c411Err&&!movie.owned&&(movie.wishlist
                  ?<p className="muted">La recherche automatique réessaiera plus tard.</p>
                  :<p className="muted">Ajoutez-le aux envies pour relancer la recherche plus tard.</p>)}
              </div>}
              {releases.map(r=>{
                const thisDl=dlState?.id===r.id?dlState:null;
                const loading=thisDl?.status==="loading";
                const added=thisDl?.status==="ok";
                const failed=thisDl?.status==="error";
                const otherBusy=dlState?.status==="loading"&&dlState.id!==r.id;
                return <div className={`release ${r.accepted?"accepted":"rejected"}`} key={r.id}>
                  <b>{r.title}</b>
                  <small>{size(r.size_bytes)} · S:{r.seeders} · {r.resolution} · {r.codec} · score {r.score}</small>
                  {!r.accepted&&<em>{r.rejection_reason}</em>}
                  {added?<p className="dl-ok"><span className="check-ok" aria-hidden="true"/>Ajouté à Transmission</p>
                  :loading?<button disabled className="btn-busy"><span className="spinner" aria-hidden="true"/>Ajout à Transmission…</button>
                  :r.accepted?<button onClick={()=>dl(r.id)} disabled={otherBusy}>Télécharger</button>
                  :r.tmdb_match!==false?<button className="ghost" onClick={()=>dl(r.id,true,r.rejection_reason)} disabled={otherBusy}>Forcer le téléchargement</button>
                  :null}
                  {failed&&<em>{thisDl?.msg||"Erreur"}</em>}
                </div>;
              })}
            </div>
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
