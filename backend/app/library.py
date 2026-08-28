import re
from pathlib import Path
from app.config import settings
from app.db import LibraryFile

VIDEO={".mkv",".mp4",".m4v",".avi",".ts",".m2ts",".mpeg",".mpg"}

def parse_name(name):
    stem=Path(name).stem
    ym=re.search(r"(?<!\d)((?:19|20)\d{2})(?!\d)",stem)
    year=int(ym.group(1)) if ym else None
    cut=ym.start() if ym else len(stem)
    title=re.sub(r"[._]+"," ",stem[:cut]).strip(" -._")
    up=stem.upper()
    rm=re.search(r"(?i)\b(2160p|1080p|720p|576p|480p)\b",stem)
    res=rm.group(1) if rm else ""
    codec=next((x for x in ["x265","H265","HEVC","x264","H264","AV1"] if x.upper() in up),"")
    lang="MULTI" if "MULTI" in up else ("FRENCH" if any(x in up for x in ["FRENCH","VFF","VFQ"]) else "")
    source=next((x for x in ["WEB-DL","WEBRIP","BLURAY","WEB","HDTV","REMUX"] if x in up.replace(".","-")),"")
    gm=re.search(r"-([A-Za-z0-9]{2,32})$",stem)
    return title,year,res,codec,lang,source,(gm.group(1) if gm else "")

def normalize(s):
    s=(s or "").lower()
    s=re.sub(r"[^a-z0-9à-ÿ]+"," ",s)
    return re.sub(r"\s+"," ",s).strip()

def scan(db):
    root=Path(settings.library_path)
    seen=set()
    stats={"added":0,"updated":0,"unchanged":0,"removed":0}
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in VIDEO:
            continue
        st=p.stat(); seen.add(str(p))
        row=db.query(LibraryFile).filter_by(path=str(p)).first()
        if row and row.size_bytes==st.st_size and row.mtime==st.st_mtime:
            stats["unchanged"]+=1; continue
        title,year,res,codec,lang,source,group=parse_name(p.name)
        if not row:
            row=LibraryFile(path=str(p),filename=p.name)
            db.add(row); stats["added"]+=1
        else:
            stats["updated"]+=1
        row.filename=p.name; row.size_bytes=st.st_size; row.mtime=st.st_mtime
        row.parsed_title=title; row.parsed_year=year; row.resolution=res
        row.codec=codec; row.language=lang; row.source=source; row.release_group=group

    for row in db.query(LibraryFile).all():
        if row.path not in seen:
            db.delete(row); stats["removed"]+=1
    db.commit()
    return stats

def local_matches(db,title,original_title,year):
    names={normalize(title),normalize(original_title)}
    out=[]
    for r in db.query(LibraryFile).all():
        if year and r.parsed_year and r.parsed_year!=year:
            continue
        if normalize(r.parsed_title) in names:
            out.append(r)
    return out

def db_search(db, q, limit=30):
    """Recherche dans movies + fichiers bibliothèque (titre contient la requête)."""
    from app.db import Movie
    nq = normalize(q)
    if not nq:
        return []
    out = []
    seen = set()

    for m in db.query(Movie).all():
        hay = f"{normalize(m.title)} {normalize(m.original_title)}"
        if nq not in hay:
            continue
        key = m.tmdb_id or f"movie:{m.id}"
        if key in seen:
            continue
        seen.add(key)
        owned = bool(local_matches(db, m.title, m.original_title, m.year))
        out.append({
            "tmdb_id": m.tmdb_id,
            "title": m.title,
            "original_title": m.original_title,
            "year": m.year,
            "poster_path": m.poster_path,
            "owned": owned,
            "source": "local",
        })
        if len(out) >= limit:
            return out

    for f in db.query(LibraryFile).all():
        title = f.parsed_title or ""
        if nq not in normalize(title):
            continue
        key = f"file:{normalize(title)}:{f.parsed_year}"
        if key in seen:
            continue
        seen.add(key)
        # rattache un Movie existant si possible
        movie = None
        for m in db.query(Movie).all():
            if normalize(m.title) == normalize(title) or normalize(m.original_title or "") == normalize(title):
                if not f.parsed_year or not m.year or m.year == f.parsed_year:
                    movie = m
                    break
        if movie and movie.tmdb_id:
            if movie.tmdb_id in seen:
                continue
            seen.add(movie.tmdb_id)
            out.append({
                "tmdb_id": movie.tmdb_id,
                "title": movie.title,
                "original_title": movie.original_title,
                "year": movie.year,
                "poster_path": movie.poster_path,
                "owned": True,
                "source": "local",
            })
        else:
            out.append({
                "tmdb_id": None,
                "title": title,
                "original_title": title,
                "year": f.parsed_year,
                "poster_path": None,
                "owned": True,
                "source": "local",
                "local_filename": f.filename,
            })
        if len(out) >= limit:
            break
    return out
