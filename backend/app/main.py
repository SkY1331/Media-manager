import asyncio
from datetime import datetime
import requests
from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.auth import auth_enabled, install_auth
from app.config import settings
from app.db import get_db, SessionLocal, Movie, Wishlist, Release, Download, DiscoveryIgnore
from app.discovery import (
    load_discovery_settings, save_discovery_settings, validate_discovery_updates,
    fetch_discovery, process_discovery,
)
from app.library import scan, local_matches, db_search
from app.services import tmdb_search, tmdb_get, c411_search, c411_candidate_titles, transmission, torrent_incomplete, TORRENT_STATUS, norm, release_matches_tmdb

app=FastAPI(title=settings.app_name,version="0.1.0")
install_auth(app)

class GrabDownloadSettings(BaseModel):
    quality_required_language: str
    quality_preferred_resolution: str
    quality_preferred_codecs: str
    quality_max_size_gb: float
    quality_allowed_sources: str
    quality_min_seeders: int
    c411_categories: str
    c411_request_delay_seconds: float
    transmission_download_dir: str

class GrabDownloadSettingsUpdate(BaseModel):
    quality_required_language: str | None = None
    quality_preferred_resolution: str | None = None
    quality_preferred_codecs: str | None = None
    quality_max_size_gb: float | None = None
    quality_allowed_sources: str | None = None
    quality_min_seeders: int | None = None
    c411_categories: str | None = None
    c411_request_delay_seconds: float | None = None
    transmission_download_dir: str | None = None

class WishlistUpdate(BaseModel):
    auto_download: bool | None = None
    status: str | None = None

class DiscoverySettingsUpdate(BaseModel):
    min_rating: float | None = None
    min_votes: int | None = None
    released_days: int | None = None
    upcoming_days: int | None = None
    max_results: int | None = None
    auto_add_nouveautes: bool | None = None
    auto_add_attendus: bool | None = None
    auto_add_classiques: bool | None = None
    auto_download: bool | None = None
    classic_min_rating: float | None = None
    classic_min_votes: int | None = None
    classic_min_age_years: int | None = None

WISHLIST_EDITABLE_STATUS = {"WAITING", "PAUSED"}

def serialize_wish(w, m):
    return {
        "id": w.id,
        "tmdb_id": m.tmdb_id if m else None,
        "title": m.title if m else "Inconnu",
        "year": m.year if m else None,
        "poster_path": m.poster_path if m else None,
        "status": w.status,
        "auto_download": w.auto_download,
    }

def clear_wishlist_for_movie(db, movie_id):
    w=db.query(Wishlist).filter_by(movie_id=movie_id).first()
    if not w:
        return False
    db.delete(w)
    return True

def read_grab_download_settings():
    return GrabDownloadSettings(
        quality_required_language=settings.quality_required_language,
        quality_preferred_resolution=settings.quality_preferred_resolution,
        quality_preferred_codecs=settings.quality_preferred_codecs,
        quality_max_size_gb=settings.quality_max_size_gb,
        quality_allowed_sources=settings.quality_allowed_sources,
        quality_min_seeders=settings.quality_min_seeders,
        c411_categories=settings.c411_categories,
        c411_request_delay_seconds=settings.c411_request_delay_seconds,
        transmission_download_dir=settings.transmission_download_dir,
    )

def ensure_movie(db,tmdb_id):
    m=db.query(Movie).filter_by(tmdb_id=tmdb_id).first()
    if m: return m
    x=tmdb_get(tmdb_id)
    m=Movie(tmdb_id=x["tmdb_id"],title=x["title"],original_title=x["original_title"],
            year=x["year"],poster_path=x["poster_path"],status="MISSING")
    db.add(m); db.commit(); db.refresh(m); return m

@app.get("/api/health")
def health(): return {"ok":True}

@app.post("/api/library/scan")
def scan_library(db:Session=Depends(get_db)): return scan(db)

@app.get("/api/settings/grab-download")
def get_grab_download_settings():
    return read_grab_download_settings().model_dump()

@app.put("/api/settings/grab-download")
def update_grab_download_settings(payload: GrabDownloadSettingsUpdate):
    updates=payload.model_dump(exclude_none=True)
    if "quality_max_size_gb" in updates and updates["quality_max_size_gb"] <= 0:
        raise HTTPException(400,"quality_max_size_gb doit être > 0")
    if "quality_min_seeders" in updates and updates["quality_min_seeders"] < 0:
        raise HTTPException(400,"quality_min_seeders doit être >= 0")
    if "c411_request_delay_seconds" in updates and updates["c411_request_delay_seconds"] < 0:
        raise HTTPException(400,"c411_request_delay_seconds doit être >= 0")

    for key, value in updates.items():
        setattr(settings, key, value)
    return {"ok":True,"settings":read_grab_download_settings().model_dump()}

@app.get("/api/search")
def search(q:str,db:Session=Depends(get_db)):
    q=(q or "").strip()
    if not q:
        return {"results":[],"empty":True,"message":"Saisissez un titre à rechercher.","sources":{"tmdb":0,"local":0,"c411":0}}

    by_id={}
    sources={"tmdb":0,"local":0,"c411":0}

    def upsert(item, source):
        tid=item.get("tmdb_id")
        if tid:
            existing=by_id.get(tid)
            if existing:
                existing["owned"]=existing.get("owned") or item.get("owned",False)
                tags=set(existing.get("sources") or [existing.get("source")])
                if source not in tags:
                    sources[source]=sources.get(source,0)+1
                tags.add(source)
                existing["sources"]=sorted(tags)
                if "local" in tags:
                    existing["source"]="local"
                elif "tmdb" in tags:
                    existing["source"]="tmdb"
                else:
                    existing["source"]=source
                if not existing.get("poster_path") and item.get("poster_path"):
                    existing["poster_path"]=item["poster_path"]
            else:
                row={**item,"source":source,"sources":[source]}
                if "owned" not in row or row["owned"] is None:
                    row["owned"]=bool(local_matches(db,row.get("title"),row.get("original_title"),row.get("year")))
                by_id[tid]=row
                sources[source]=sources.get(source,0)+1
            return
        key=f"{source}:{norm(item.get('title'))}:{item.get('year')}"
        if key not in by_id:
            by_id[key]={**item,"source":source,"sources":[source],"owned":bool(item.get("owned"))}
            sources[source]=sources.get(source,0)+1

    # 1) TMDB
    try:
        tmdb_items=tmdb_search(q)
    except Exception as e:
        tmdb_items=[]
        print("[search tmdb]",e)
    for x in tmdb_items:
        upsert(x,"tmdb")

    # 2) BDD locale (films connus + bibliothèque)
    for x in db_search(db,q):
        upsert(x,"local")

    # 3) Approfondir via C411 si TMDB vide (ou très peu de hits)
    c411_note=None
    if len([k for k in by_id if not str(k).startswith("local:")])==0:
        try:
            candidates=c411_candidate_titles(q, limit=8)
            c411_note=f"{len(candidates)} titre(s) déduits de C411"
            for c in candidates:
                try:
                    hits=tmdb_search(c["title"])
                except Exception:
                    hits=[]
                # préfère le hit avec la même année si connue
                picked=None
                if c.get("year"):
                    picked=next((h for h in hits if h.get("year")==c["year"]),None)
                picked=picked or (hits[0] if hits else None)
                if picked:
                    upsert(picked,"c411")
                else:
                    # fallback brut C411 sans fiche TMDB
                    key=f"c411:{norm(c['title'])}:{c.get('year')}"
                    if key not in by_id:
                        by_id[key]={
                            "tmdb_id":None,"title":c["title"],"original_title":c["title"],
                            "year":c.get("year"),"poster_path":None,"owned":False,
                            "source":"c411","sources":["c411"],"hint":c.get("release"),
                        }
                        sources["c411"]+=1
        except Exception as e:
            print("[search c411]",e)
            c411_note=str(e)

    results=list(by_id.values())
    # tri: owned d'abord, puis tmdb_id présent, puis titre
    results.sort(key=lambda x:(-int(bool(x.get("owned"))), -int(bool(x.get("tmdb_id"))), (x.get("title") or "").lower()))

    empty=len(results)==0
    message=None
    if empty:
        message="Rien trouvé sur TMDB, C411 ni dans la bibliothèque locale."
    elif sources["tmdb"]==0 and sources["c411"]>0:
        message="Aucun résultat TMDB direct — résultats approfondis via C411."
    elif sources["tmdb"]==0 and sources["local"]>0:
        message="Aucun résultat TMDB — résultats trouvés dans la bibliothèque locale."

    return {"results":results,"empty":empty,"message":message,"sources":sources,"c411_note":c411_note}

@app.get("/api/movies/{tmdb_id}")
def movie(tmdb_id:int,db:Session=Depends(get_db)):
    m=ensure_movie(db,tmdb_id)
    matches=local_matches(db,m.title,m.original_title,m.year)
    wish=db.query(Wishlist).filter_by(movie_id=m.id).first()
    extra={}
    try: extra=tmdb_get(tmdb_id)
    except Exception: pass
    return {
        "tmdb_id":m.tmdb_id,"title":m.title,"original_title":m.original_title,"year":m.year,
        "poster_path":m.poster_path,"owned":bool(matches),
        "release_date":extra.get("release_date"),
        "vote_average":extra.get("vote_average"),
        "vote_count":extra.get("vote_count"),
        "popularity":extra.get("popularity"),
        "overview":extra.get("overview") or "",
        "local_files":[{"path":x.path,"filename":x.filename,"size_bytes":x.size_bytes,
                        "resolution":x.resolution,"codec":x.codec,"language":x.language,"source":x.source}
                       for x in matches],
        "wishlist":None if not wish else {"id":wish.id,"status":wish.status,"auto_download":wish.auto_download}
    }

@app.get("/api/movies/{tmdb_id}/releases")
def releases(tmdb_id:int,db:Session=Depends(get_db)):
    m=ensure_movie(db,tmdb_id)
    found=c411_search(m.title,m.year,m.original_title,verify_tmdb=True)
    out=[]
    for x in found:
        r=Release(movie_id=m.id,title=x["title"],size_bytes=x["size_bytes"],seeders=x["seeders"],
                  leechers=x["leechers"],resolution=x["resolution"],codec=x["codec"],
                  language=x["language"],source=x["source"],release_group=x["release_group"],
                  score=x["score"],accepted=x["accepted"],rejection_reason=x["rejection_reason"],
                  infohash=x["infohash"])
        db.add(r); db.flush()
        y={k:v for k,v in x.items() if k!="download_url"}; y["id"]=r.id; out.append(y)
    db.commit()
    empty=len(out)==0
    return {
        "results":out,
        "empty":empty,
        "message":None if not empty else "Aucune release trouvée sur C411 pour ce film.",
    }

@app.post("/api/releases/{release_id}/download")
def download(release_id:int,force:bool=False,db:Session=Depends(get_db)):
    r=db.get(Release,release_id)
    if not r: raise HTTPException(404,"Release introuvable")
    m=db.get(Movie,r.movie_id)
    fresh=c411_search(m.title,m.year,m.original_title,verify_tmdb=True)
    hit=next((x for x in fresh if x["infohash"].lower()==(r.infohash or "").lower()),None)
    if not hit or not hit["download_url"]:
        raise HTTPException(409,"Release plus disponible")
    if not hit.get("tmdb_match", True):
        reason=hit.get("rejection_reason") or "titre différent de TMDB"
        raise HTTPException(409,f"Release non conforme: {reason}")
    if not force and not hit["accepted"]:
        reason=hit.get("rejection_reason") or "hors paramètres"
        raise HTTPException(409,f"Release non conforme: {reason}")
    added=transmission.add_url(hit["download_url"])
    info=added.get("torrent-added") or added.get("torrent-duplicate") or {}
    db.add(Download(movie_id=m.id,release_id=r.id,transmission_hash=info.get("hashString")))
    m.status="DOWNLOADING"
    clear_wishlist_for_movie(db, m.id)
    db.commit()
    return {"ok":True,"transmission":info}

@app.get("/api/discovery")
def discovery(db:Session=Depends(get_db)):
    try:
        return fetch_discovery(db)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        print("[discovery]", e)
        raise HTTPException(502, "Impossible de charger les nouveautés TMDB")

@app.get("/api/settings/discovery")
def get_discovery_settings(db:Session=Depends(get_db)):
    return load_discovery_settings(db)

@app.put("/api/settings/discovery")
def update_discovery_settings(payload: DiscoverySettingsUpdate, db:Session=Depends(get_db)):
    updates=payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400,"Aucun champ à modifier")
    try:
        updates=validate_discovery_updates(updates)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))
    cfg=save_discovery_settings(db, updates)
    applied=None
    if cfg["auto_add_nouveautes"] or cfg["auto_add_attendus"] or cfg["auto_add_classiques"]:
        try:
            applied=process_discovery(db)
        except Exception as e:
            print("[discovery auto-add]", e)
            applied={"error":str(e)}
    return {"ok":True,"settings":cfg,"applied":applied}

@app.post("/api/discovery/{tmdb_id}/ignore")
def ignore_discovery(tmdb_id:int, db:Session=Depends(get_db)):
    if db.get(DiscoveryIgnore, tmdb_id):
        return {"ok":True}
    title=None
    m=db.query(Movie).filter_by(tmdb_id=tmdb_id).first()
    if m:
        title=m.title
    db.add(DiscoveryIgnore(tmdb_id=tmdb_id, title=title))
    db.commit()
    return {"ok":True}

@app.get("/api/wishlist")
def wishlist(db:Session=Depends(get_db)):
    downloaded={d.movie_id for d in db.query(Download).all()}
    dirty=False
    out=[]
    for w in db.query(Wishlist).all():
        if w.movie_id in downloaded:
            db.delete(w)
            dirty=True
            continue
        out.append(serialize_wish(w, db.get(Movie,w.movie_id)))
    if dirty:
        db.commit()
    return {"items":out}

@app.post("/api/movies/{tmdb_id}/wishlist")
def add_wishlist(tmdb_id:int,auto_download:bool=False,db:Session=Depends(get_db)):
    m=ensure_movie(db,tmdb_id)
    w=db.query(Wishlist).filter_by(movie_id=m.id).first()
    if not w:
        w=Wishlist(movie_id=m.id,auto_download=auto_download,status="WAITING"); db.add(w)
    else:
        w.auto_download=auto_download
        if w.status=="PAUSED":
            w.status="WAITING"
    m.status="WANTED"; db.commit()
    return {"ok":True,"item":serialize_wish(w,m)}

@app.put("/api/wishlist/{wish_id}")
def update_wishlist(wish_id:int, payload:WishlistUpdate, db:Session=Depends(get_db)):
    w=db.get(Wishlist,wish_id)
    if not w:
        raise HTTPException(404,"Envie introuvable")
    updates=payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400,"Aucun champ à modifier")
    if "status" in updates and updates["status"] not in WISHLIST_EDITABLE_STATUS:
        raise HTTPException(400,"Statut invalide (WAITING ou PAUSED)")
    if "auto_download" in updates:
        w.auto_download=updates["auto_download"]
    if "status" in updates:
        w.status=updates["status"]
    m=db.get(Movie,w.movie_id)
    if m:
        m.status="WANTED" if w.status!="PAUSED" else m.status
    db.commit()
    return {"ok":True,"item":serialize_wish(w,m)}

@app.delete("/api/wishlist/{wish_id}")
def delete_wishlist(wish_id:int, db:Session=Depends(get_db)):
    w=db.get(Wishlist,wish_id)
    if not w:
        raise HTTPException(404,"Envie introuvable")
    m=db.get(Movie,w.movie_id)
    db.delete(w)
    if m and m.status=="WANTED":
        m.status="MISSING"
    db.commit()
    return {"ok":True}

@app.get("/api/downloads")
def downloads(db:Session=Depends(get_db)):
    try:
        torrents=transmission.list()
    except Exception as e:
        print("[downloads]",e)
        return {"items":[],"error":"Transmission indisponible"}
    live={x.get("hashString"):x for x in torrents if x.get("hashString")}
    by_hash={d.transmission_hash:d for d in db.query(Download).all() if d.transmission_hash}
    dirty=False
    for d in by_hash.values():
        t=live.get(d.transmission_hash)
        if t and not torrent_incomplete(t) and d.status!="COMPLETED":
            d.status="COMPLETED"; dirty=True
        if clear_wishlist_for_movie(db, d.movie_id):
            dirty=True
    if dirty:
        db.commit()
    out=[]
    for t in torrents:
        if not torrent_incomplete(t):
            continue
        d=by_hash.get(t.get("hashString"))
        m=db.get(Movie,d.movie_id) if d else None
        out.append({
            "id":t.get("id"),
            "hash":t.get("hashString"),
            "tmdb_id":m.tmdb_id if m else None,
            "title":m.title if m else t.get("name") or "Inconnu",
            "name":t.get("name") or "",
            "status":TORRENT_STATUS.get(t.get("status"), "Téléchargement"),
            "progress":round(float(t.get("percentDone") or 0)*100,1),
            "rate_download":t.get("rateDownload") or 0,
            "eta":t.get("eta"),
            "error":t.get("errorString") or None,
            "size_bytes":t.get("sizeWhenDone") or 0,
        })
    return {"items":out}

def process_wishlist():
    db=SessionLocal()
    try:
        for w in db.query(Wishlist).filter(Wishlist.status.in_(["WAITING","FOUND"])).all():
            m=db.get(Movie,w.movie_id)
            if not m:
                continue
            if db.query(Download).filter_by(movie_id=m.id).first() or local_matches(db,m.title,m.original_title,m.year):
                db.delete(w)
                continue
            found=[]
            for x in c411_search(m.title,m.year,m.original_title,verify_tmdb=True):
                if not x["accepted"] or not x.get("tmdb_match",True):
                    continue
                ok,_=release_matches_tmdb(x["title"],m.title,m.original_title,m.year)
                if ok:
                    found.append(x)
            w.last_checked_at=datetime.utcnow()
            if not found:
                w.status="WAITING"; continue
            best=found[0]; w.status="FOUND"
            if w.auto_download and best["download_url"]:
                ok,_=release_matches_tmdb(best["title"],m.title,m.original_title,m.year)
                if not ok:
                    continue
                added=transmission.add_url(best["download_url"])
                info=added.get("torrent-added") or added.get("torrent-duplicate") or {}
                r=Release(movie_id=m.id,title=best["title"],size_bytes=best["size_bytes"],
                          seeders=best["seeders"],leechers=best["leechers"],
                          score=best["score"],accepted=True,infohash=best["infohash"])
                db.add(r); db.flush()
                db.add(Download(movie_id=m.id,release_id=r.id,transmission_hash=info.get("hashString")))
                m.status="DOWNLOADING"
                db.delete(w)
        db.commit()
    finally:
        db.close()

async def wishlist_loop():
    while True:
        try: process_wishlist()
        except Exception as e: print("[wishlist]",e)
        await asyncio.sleep(max(60,settings.wishlist_interval_minutes*60))

async def discovery_loop():
    await asyncio.sleep(20)
    while True:
        try: process_discovery()
        except Exception as e: print("[discovery]",e)
        await asyncio.sleep(max(60,settings.discovery_interval_minutes*60))

@app.on_event("startup")
async def startup():
    if not auth_enabled():
        print("[auth] AUTH_ENABLE=false — interface ouverte sans mot de passe")
    elif not (settings.auth_username and settings.auth_password):
        print("[auth] AUTH_ENABLE=true mais AUTH_USERNAME / AUTH_PASSWORD absents — API bloquée")
    else:
        print("[auth] protection par mot de passe active")
    if settings.session_secret in ("", "change-me-session-secret"):
        print("[auth] ATTENTION: définissez un SESSION_SECRET unique dans .env")
    asyncio.create_task(wishlist_loop())
    asyncio.create_task(discovery_loop())
