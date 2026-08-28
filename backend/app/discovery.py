import json
from datetime import date, timedelta
from app.config import settings
from app.db import AppSetting, DiscoveryIgnore, DiscoveryAutoAdded, Movie, Wishlist, Download
from app.library import local_matches
from app.services import tmdb_discover

SETTING_KEY = "discovery"

BOOL_KEYS = ("auto_add_nouveautes", "auto_add_attendus", "auto_add_classiques", "auto_download")
INT_KEYS = ("min_votes", "released_days", "upcoming_days", "max_results", "classic_min_votes", "classic_min_age_years")

def default_discovery_settings():
    return {
        "min_rating": float(settings.discovery_min_rating),
        "min_votes": int(settings.discovery_min_votes),
        "released_days": int(settings.discovery_released_days),
        "upcoming_days": int(settings.discovery_upcoming_days),
        "max_results": int(settings.discovery_max_results),
        "auto_add_nouveautes": bool(settings.discovery_auto_add_nouveautes),
        "auto_add_attendus": bool(settings.discovery_auto_add_attendus),
        "auto_add_classiques": bool(settings.discovery_auto_add_classiques),
        "auto_download": bool(settings.discovery_auto_download),
        "classic_min_rating": float(settings.discovery_classic_min_rating),
        "classic_min_votes": int(settings.discovery_classic_min_votes),
        "classic_min_age_years": int(settings.discovery_classic_min_age_years),
    }

def load_discovery_settings(db):
    cfg = default_discovery_settings()
    row = db.get(AppSetting, SETTING_KEY)
    if not row:
        return cfg
    try:
        data = json.loads(row.value)
    except Exception:
        return cfg
    if not isinstance(data, dict):
        return cfg
    for key in cfg:
        if key not in data:
            continue
        if key in BOOL_KEYS:
            cfg[key] = bool(data[key])
        elif key in INT_KEYS:
            cfg[key] = int(data[key])
        else:
            cfg[key] = float(data[key])
    return cfg

def save_discovery_settings(db, updates):
    cfg = load_discovery_settings(db)
    cfg.update(updates)
    row = db.get(AppSetting, SETTING_KEY)
    payload = json.dumps(cfg)
    if not row:
        db.add(AppSetting(key=SETTING_KEY, value=payload))
    else:
        row.value = payload
    db.commit()
    return cfg

def validate_discovery_updates(updates):
    if "min_rating" in updates:
        v = float(updates["min_rating"])
        if v < 0 or v > 10:
            raise ValueError("min_rating doit être entre 0 et 10")
        updates["min_rating"] = v
    if "classic_min_rating" in updates:
        v = float(updates["classic_min_rating"])
        if v < 0 or v > 10:
            raise ValueError("classic_min_rating doit être entre 0 et 10")
        updates["classic_min_rating"] = v
    if "min_votes" in updates:
        v = int(updates["min_votes"])
        if v < 0:
            raise ValueError("min_votes doit être >= 0")
        updates["min_votes"] = v
    if "classic_min_votes" in updates:
        v = int(updates["classic_min_votes"])
        if v < 0:
            raise ValueError("classic_min_votes doit être >= 0")
        updates["classic_min_votes"] = v
    if "classic_min_age_years" in updates:
        v = int(updates["classic_min_age_years"])
        if v < 1 or v > 80:
            raise ValueError("classic_min_age_years doit être entre 1 et 80")
        updates["classic_min_age_years"] = v
    for key in ("released_days", "upcoming_days"):
        if key in updates:
            v = int(updates[key])
            if v < 1 or v > 365:
                raise ValueError(f"{key} doit être entre 1 et 365")
            updates[key] = v
    if "max_results" in updates:
        v = int(updates["max_results"])
        if v < 1 or v > 50:
            raise ValueError("max_results doit être entre 1 et 50")
        updates["max_results"] = v
    for key in BOOL_KEYS:
        if key in updates:
            updates[key] = bool(updates[key])
    return updates

def _tmdb_ids_for_movie_ids(db, movie_ids):
    out = set()
    ids = [i for i in movie_ids if i]
    if not ids:
        return out
    for m in db.query(Movie).filter(Movie.id.in_(ids)).all():
        if m.tmdb_id:
            out.add(m.tmdb_id)
    return out

def hidden_discovery_tmdb_ids(db):
    hidden = set()
    hidden |= _tmdb_ids_for_movie_ids(db, [w.movie_id for w in db.query(Wishlist).all()])
    hidden |= _tmdb_ids_for_movie_ids(db, [d.movie_id for d in db.query(Download).all()])
    for m in db.query(Movie).filter(Movie.status == "DOWNLOADING").all():
        if m.tmdb_id:
            hidden.add(m.tmdb_id)
    return hidden

def annotate_items(db, items, ignored):
    hidden = hidden_discovery_tmdb_ids(db)
    movies_by_tmdb = {m.tmdb_id: m for m in db.query(Movie).filter(Movie.tmdb_id.isnot(None)).all()}
    out = []
    for x in items:
        tid = x.get("tmdb_id")
        if not tid or tid in ignored or tid in hidden:
            continue
        owned = bool(local_matches(db, x.get("title"), x.get("original_title"), x.get("year")))
        m = movies_by_tmdb.get(tid)
        if not owned and m:
            owned = bool(local_matches(db, m.title, m.original_title, m.year))
        if owned:
            continue
        out.append({
            **x,
            "owned": False,
            "wishlist": None,
        })
    return out

def fetch_discovery(db, cfg=None):
    cfg = cfg or load_discovery_settings(db)
    today = date.today()
    ignored = {r.tmdb_id for r in db.query(DiscoveryIgnore).all()}
    limit = int(cfg["max_results"])
    nouveautes = tmdb_discover(
        release_gte=(today - timedelta(days=int(cfg["released_days"]))).isoformat(),
        release_lte=today.isoformat(),
        min_rating=float(cfg["min_rating"]),
        min_votes=int(cfg["min_votes"]),
        sort_by="vote_average.desc",
        max_results=max(limit * 2, 20),
    )
    attendus = tmdb_discover(
        release_gte=(today + timedelta(days=1)).isoformat(),
        release_lte=(today + timedelta(days=int(cfg["upcoming_days"]))).isoformat(),
        min_rating=None,
        min_votes=None,
        sort_by="popularity.desc",
        max_results=max(limit * 2, 20),
    )
    min_rating = float(cfg["min_rating"])
    min_votes = int(cfg["min_votes"])
    attendus = [
        x for x in attendus
        if x["vote_count"] < min_votes or x["vote_average"] >= min_rating
    ]
    age = int(cfg["classic_min_age_years"])
    try:
        classic_lte = today.replace(year=today.year - age)
    except ValueError:
        classic_lte = today - timedelta(days=age * 365)
    classiques = tmdb_discover(
        release_lte=classic_lte.isoformat(),
        min_rating=float(cfg["classic_min_rating"]),
        min_votes=int(cfg["classic_min_votes"]),
        sort_by="vote_average.desc",
        max_results=max(limit * 5, 80),
        max_pages=8,
    )
    nouveautes_out = annotate_items(db, nouveautes, ignored)[:limit]
    seen = {x["tmdb_id"] for x in nouveautes_out}
    classiques_out = [x for x in annotate_items(db, classiques, ignored) if x["tmdb_id"] not in seen][:limit]
    return {
        "settings": cfg,
        "nouveautes": nouveautes_out,
        "attendus": annotate_items(db, attendus, ignored)[:limit],
        "classiques": classiques_out,
    }

def ensure_movie_from_card(db, x):
    m = db.query(Movie).filter_by(tmdb_id=x["tmdb_id"]).first()
    if m:
        return m
    m = Movie(
        tmdb_id=x["tmdb_id"], title=x.get("title") or "Sans titre",
        original_title=x.get("original_title"), year=x.get("year"),
        poster_path=x.get("poster_path"), status="MISSING",
    )
    db.add(m)
    db.flush()
    return m

def auto_add_items(db, items, auto_download, already):
    added = 0
    for x in items:
        tid = x.get("tmdb_id")
        if not tid or tid in already or x.get("wishlist"):
            continue
        m = ensure_movie_from_card(db, x)
        w = db.query(Wishlist).filter_by(movie_id=m.id).first()
        if w or db.query(Download).filter_by(movie_id=m.id).first():
            already.add(tid)
            continue
        db.add(Wishlist(movie_id=m.id, auto_download=auto_download, status="WAITING"))
        db.add(DiscoveryAutoAdded(tmdb_id=tid))
        m.status = "WANTED"
        already.add(tid)
        added += 1
    return added

def process_discovery(db=None):
    own = db is None
    if own:
        from app.db import SessionLocal
        db = SessionLocal()
    try:
        cfg = load_discovery_settings(db)
        if not cfg["auto_add_nouveautes"] and not cfg["auto_add_attendus"] and not cfg["auto_add_classiques"]:
            return {"added": 0, "nouveautes": 0, "attendus": 0, "classiques": 0}
        data = fetch_discovery(db, cfg)
        already = {r.tmdb_id for r in db.query(DiscoveryAutoAdded).all()}
        added_n = auto_add_items(
            db, data["nouveautes"], cfg["auto_download"], already
        ) if cfg["auto_add_nouveautes"] else 0
        added_a = auto_add_items(
            db, data["attendus"], cfg["auto_download"], already
        ) if cfg["auto_add_attendus"] else 0
        added_c = auto_add_items(
            db, data["classiques"], cfg["auto_download"], already
        ) if cfg["auto_add_classiques"] else 0
        db.commit()
        return {"added": added_n + added_a + added_c, "nouveautes": added_n, "attendus": added_a, "classiques": added_c}
    finally:
        if own:
            db.close()
