import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote
import requests
from app.config import settings
from app.library import normalize

_machine_id = None
_library_cache = {"key": None, "at": 0.0, "data": None, "ttl": 0.0}
_TMDB_GUID = re.compile(r"(?:tmdb|themoviedb)://(\d+)", re.I)
_LIBRARY_TTL = 15 * 60
_LIBRARY_ERROR_TTL = 60

def plex_configured():
    return bool((settings.plex_url or "").strip() and (settings.plex_token or "").strip())

def _base():
    return (settings.plex_url or "").rstrip("/")

def _headers():
    return {
        "X-Plex-Token": settings.plex_token,
        "Accept": "application/xml",
        "X-Plex-Client-Identifier": "les-envies-pour-plex",
        "X-Plex-Product": "Les envies pour Plex",
    }

def plex_search_url(title, year=None):
    q = " ".join(x for x in [(title or "").strip(), str(year) if year else ""] if x)
    return f"https://app.plex.tv/desktop/#!/search?query={quote(q)}"

def plex_details_url(rating_key, machine_id):
    key = quote(f"/library/metadata/{rating_key}", safe="")
    return f"https://app.plex.tv/desktop/#!/server/{machine_id}/details?key={key}"

def machine_identifier():
    global _machine_id
    if _machine_id:
        return _machine_id
    r = requests.get(f"{_base()}/identity", headers=_headers(), timeout=4)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    _machine_id = root.attrib.get("machineIdentifier") or ""
    return _machine_id

def _videos(xml_bytes):
    root = ET.fromstring(xml_bytes)
    return [el for el in root.iter("Video") if el.attrib.get("ratingKey")]

def find_rating_key(tmdb_id, title=None, year=None):
    if not plex_configured() or not tmdb_id:
        return None
    try:
        for guid in (
            f"tmdb://{tmdb_id}",
            f"themoviedb://{tmdb_id}",
            f"com.plexapp.agents.themoviedb://{tmdb_id}",
        ):
            r = requests.get(
                f"{_base()}/library/all",
                params={"guid": guid},
                headers=_headers(),
                timeout=4,
            )
            if not r.ok:
                continue
            videos = _videos(r.content)
            if videos:
                return videos[0].attrib.get("ratingKey")
        if title:
            r = requests.get(
                f"{_base()}/hubs/search",
                params={"query": title, "limit": 12},
                headers=_headers(),
                timeout=4,
            )
            if r.ok:
                for el in _videos(r.content):
                    if el.attrib.get("type") and el.attrib.get("type") != "movie":
                        continue
                    y = el.attrib.get("year")
                    if year and y and str(year) != str(y):
                        continue
                    return el.attrib.get("ratingKey")
    except Exception as e:
        print("[plex]", e)
    return None

def _guid_values(el):
    out = []
    raw = el.attrib.get("guid")
    if raw:
        out.append(raw)
    for child in el.findall("Guid"):
        gid = child.attrib.get("id")
        if gid:
            out.append(gid)
    return out

def _remember_title(titles, el):
    year_raw = el.attrib.get("year") or ""
    year = int(year_raw) if year_raw.isdigit() else None
    for attr in ("title", "originalTitle", "titleSort"):
        name = normalize(el.attrib.get(attr))
        if name:
            titles.add((name, year))

def _collect_movies(root, tmdb_ids, titles, seen_keys):
    added = 0
    for el in root.iter("Video"):
        if el.attrib.get("type") and el.attrib.get("type") != "movie":
            continue
        rating_key = el.attrib.get("ratingKey")
        if rating_key:
            if rating_key in seen_keys:
                continue
            seen_keys.add(rating_key)
        added += 1
        for guid in _guid_values(el):
            match = _TMDB_GUID.search(guid)
            if match:
                tmdb_ids.add(int(match.group(1)))
        _remember_title(titles, el)
    return added

def _fetch_plex_movie_index():
    tmdb_ids, titles, seen_keys = set(), set(), set()
    r = requests.get(f"{_base()}/library/sections", headers=_headers(), timeout=8)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    sections = [
        el.attrib.get("key")
        for el in root.findall("Directory")
        if el.attrib.get("type") == "movie" and el.attrib.get("key")
    ]
    for key in sections:
        start = 0
        page = 200
        while start < 20000:
            r = requests.get(
                f"{_base()}/library/sections/{key}/all",
                params={"includeGuids": 1},
                headers={
                    **_headers(),
                    "X-Plex-Container-Start": str(start),
                    "X-Plex-Container-Size": str(page),
                },
                timeout=30,
            )
            if not r.ok:
                break
            media = ET.fromstring(r.content)
            added = _collect_movies(media, tmdb_ids, titles, seen_keys)
            got = int(media.attrib.get("size") or 0)
            total = int(media.attrib.get("totalSize") or 0)
            if added <= 0 or got <= 0:
                break
            start += got
            if total and start >= total:
                break
            if not total and got < page:
                break
    return {"tmdb": tmdb_ids, "titles": titles}

def plex_movie_index():
    """Identifiants TMDB et titres déjà présents dans les bibliothèques films Plex."""
    empty = {"tmdb": set(), "titles": set()}
    if not plex_configured():
        return empty
    key = (_base(), settings.plex_token)
    now = time.monotonic()
    if _library_cache["key"] == key and _library_cache["data"] is not None and now - _library_cache["at"] < _library_cache["ttl"]:
        return _library_cache["data"]
    try:
        data = _fetch_plex_movie_index()
        ttl = _LIBRARY_TTL
    except Exception as e:
        print("[plex library]", e)
        data = empty
        ttl = _LIBRARY_ERROR_TTL
    _library_cache.update(key=key, at=now, data=data, ttl=ttl)
    return data

def plex_has_movie(index, tmdb_id=None, titles=(), year=None):
    if not index:
        return False
    if tmdb_id and int(tmdb_id) in index.get("tmdb", ()):
        return True
    try:
        year = int(year) if year else None
    except (TypeError, ValueError):
        year = None
    known = index.get("titles") or set()
    for title in titles:
        name = normalize(title)
        if not name:
            continue
        if (name, year) in known or (name, None) in known:
            return True
    return False

def plex_open_url(tmdb_id, title=None, year=None, owned=False):
    if not owned:
        return None
    rk = find_rating_key(tmdb_id, title, year)
    if rk:
        try:
            mid = machine_identifier()
            if mid:
                return plex_details_url(rk, mid)
        except Exception as e:
            print("[plex identity]", e)
    return plex_search_url(title, year)
