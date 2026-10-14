import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from app.config import settings
from app.db import AppSetting, DiscoveryIgnore, DiscoveryAutoAdded, Movie, Wishlist, Download
from app.library import local_matches
from app.plex import plex_has_movie, plex_movie_index
from app.services import (
    aggregate_c411_completions, c411_browse_movies, tmdb_discover, tmdb_get, tmdb_search,
)

SETTING_KEY = "discovery"

BOOL_KEYS = ("auto_add_nouveautes", "auto_add_attendus", "auto_add_classiques", "auto_download")
INT_KEYS = ("min_votes", "released_days", "upcoming_days", "max_results", "classic_min_votes", "classic_min_age_years", "popularity_days")
POPULARITY_PERIODS = (1, 7, 30)

def default_discovery_settings():
    return {
        "min_rating": float(settings.discovery_min_rating),
        "min_votes": int(settings.discovery_min_votes),
        "released_days": int(settings.discovery_released_days),
        "popularity_days": int(settings.discovery_popularity_days),
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
    cfg["popularity_days"] = normalize_popularity_days(cfg.get("popularity_days"))
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

def normalize_popularity_days(value):
    try:
        v = int(value)
    except (TypeError, ValueError):
        return 7
    if v in POPULARITY_PERIODS:
        return v
    return min(POPULARITY_PERIODS, key=lambda p: abs(p - v))

def popularity_page_cap(days):
    """Assez de pages pour couvrir la période : le top n'est pas dans les derniers envois."""
    days = int(days)
    if days <= 1:
        return 8
    if days <= 7:
        return 25
    return 40

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
    if "popularity_days" in updates:
        v = normalize_popularity_days(updates["popularity_days"])
        if int(updates["popularity_days"]) not in POPULARITY_PERIODS:
            raise ValueError("popularity_days doit être 1 (24 h), 7 ou 30")
        updates["popularity_days"] = v
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

def annotate_items(db, items, ignored, plex_index=None):
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
        if not owned and plex_index:
            names = [x.get("title"), x.get("original_title")]
            year = x.get("year")
            if m:
                names.extend([m.title, m.original_title])
                year = year or m.year
            owned = plex_has_movie(plex_index, tid, names, year)
        if owned:
            continue
        out.append({
            **x,
            "owned": False,
            "wishlist": None,
        })
    return out

_popularity_cache = {"at": 0.0, "sig": None, "items": None, "source": "c411"}
_POP_TTL = 20 * 60
_POP_REFRESH_TTL = 90

def _tmdb_rated_nouveautes(cfg, today, limit):
    return tmdb_discover(
        release_gte=(today - timedelta(days=int(cfg["released_days"]))).isoformat(),
        release_lte=today.isoformat(),
        min_rating=float(cfg["min_rating"]),
        min_votes=int(cfg["min_votes"]),
        sort_by="vote_average.desc",
        max_results=max(limit * 2, 20),
    )

def _recent_by_completions(ranked, wanted):
    """Résout les films déjà classés par complétions C411, sans filtre de date de sortie."""
    candidates = []
    searches = 0
    seen = set()
    for row in ranked:
        if len(candidates) >= max(wanted, 40):
            break
        if int(row.get("grabs") or 0) <= 0:
            continue
        year = row.get("year")
        tid = row.get("tmdb_id")
        if not tid:
            if searches >= 30:
                continue
            searches += 1
            try:
                hits = tmdb_search(row.get("title") or "")
            except Exception:
                continue
            picked = next((h for h in hits if year and h.get("year") == year), None)
            picked = picked or (hits[0] if hits else None)
            if not picked:
                continue
            tid = picked["tmdb_id"]
            row = {**row, "tmdb_id": tid}
        if tid in seen:
            continue
        seen.add(tid)
        candidates.append(row)

    def load(row):
        try:
            return row, tmdb_get(row["tmdb_id"])
        except Exception:
            return row, None

    out = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        loaded = list(pool.map(load, candidates))
    for row, meta in loaded:
        if not meta:
            continue
        out.append({
            **meta,
            "c411_grabs": int(row.get("grabs") or 0),
            "c411_releases": int(row.get("releases") or 0),
        })
    out.sort(key=lambda x: x["c411_grabs"], reverse=True)
    return out[:wanted]

def load_popular_nouveautes(cfg, today, limit, refresh=False):
    """Films récents classés par complétions C411. Repli sur la note TMDB si C411 ne répond pas."""
    sig = (int(cfg["max_results"]), int(cfg["popularity_days"]))
    now = time.monotonic()
    cached = _popularity_cache["items"]
    age = now - _popularity_cache["at"]
    max_age = _POP_REFRESH_TTL if refresh else _POP_TTL
    if cached is not None and _popularity_cache["sig"] == sig and age < max_age:
        return cached, _popularity_cache["source"]
    source = "c411"
    try:
        since = datetime.now(timezone.utc) - timedelta(days=int(cfg["popularity_days"]))
        raw = c411_browse_movies(
            pages=popularity_page_cap(cfg["popularity_days"]),
            page_size=100,
            since=since,
            categories="2030",
        )
        ranked = aggregate_c411_completions(raw)
        if not ranked or max(x["grabs"] for x in ranked) <= 0:
            raise RuntimeError("C411 n'a renvoyé aucune complétion")
        print(
            "[discovery popularité]",
            len(raw), "torrents Film,",
            ranked[0].get("title"), ranked[0].get("grabs"), "complétions",
        )
        items = _recent_by_completions(ranked, max(limit * 2, 20))
    except Exception as e:
        print("[discovery popularité]", e)
        items = _tmdb_rated_nouveautes(cfg, today, limit)
        source = "tmdb"
    _popularity_cache.update(at=now, sig=sig, items=items, source=source)
    return items, source

def fetch_discovery(db, cfg=None, refresh=False):
    cfg = cfg or load_discovery_settings(db)
    today = date.today()
    ignored = {r.tmdb_id for r in db.query(DiscoveryIgnore).all()}
    limit = int(cfg["max_results"])
    nouveautes, nouveautes_source = load_popular_nouveautes(cfg, today, limit, refresh=refresh)
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
        max_results=max(limit * 10, 200),
        max_pages=12,
    )
    nouveautes_out = annotate_items(db, nouveautes, ignored)[:limit]
    seen = {x["tmdb_id"] for x in nouveautes_out}
    plex_index = plex_movie_index()
    classiques_out = [
        x for x in annotate_items(db, classiques, ignored, plex_index)
        if x["tmdb_id"] not in seen
    ][:limit]
    return {
        "settings": cfg,
        "nouveautes": nouveautes_out,
        "nouveautes_source": nouveautes_source,
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
