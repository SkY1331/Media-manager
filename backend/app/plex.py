import xml.etree.ElementTree as ET
from urllib.parse import quote
import requests
from app.config import settings

_machine_id = None

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
