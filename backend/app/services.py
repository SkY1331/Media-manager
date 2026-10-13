import base64, re, time, unicodedata, urllib.parse, xml.etree.ElementTree as ET
from pathlib import Path
import requests
from app.config import settings

TORZNAB = {"torznab": "http://torznab.com/schemas/2015/feed"}
_last_c411 = 0.0
_LIGATURES = str.maketrans({"œ": "oe", "Œ": "oe", "æ": "ae", "Æ": "ae", "ß": "ss"})

def norm(s):
    """Normalise un titre pour comparaison C411/TMDB (accents, ligatures, ponctuation)."""
    s = unicodedata.normalize("NFKD", (s or "").translate(_LIGATURES))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def parse_release(name):
    up = name.upper()
    m = re.search(r"(?i)\b(2160p|1080p|720p|576p|480p)\b", name)
    resolution = m.group(1) if m else ""
    codec = next((x for x in ["x265","H265","HEVC","x264","H264","AV1"] if x.upper() in up), "")
    language = "MULTI" if "MULTI" in up else ("FRENCH" if any(x in up for x in ["FRENCH","VFF","VFQ"]) else "")
    source = next((x for x in ["WEB-DL","WEBRIP","BLURAY","WEB","HDTV","REMUX"] if x in up.replace(".","-")), "")
    gm = re.search(r"-([A-Za-z0-9]{2,32})$", name)
    group = gm.group(1) if gm else ""
    return resolution, codec, language, source, group

def score_release(name, size_bytes, seeders, expected_title=None, expected_original=None, expected_year=None):
    resolution, codec, language, source, group = parse_release(name)
    reject = []
    score = 0.0

    tmdb_match = True
    if expected_title:
        ok, reason = release_matches_tmdb(name, expected_title, expected_original, expected_year)
        if not ok:
            tmdb_match = False
            reject.append(reason)

    if settings.quality_required_language.upper() not in name.upper():
        reject.append("MULTI requis")
    if size_bytes > int(settings.quality_max_size_gb * 1024**3):
        reject.append(f"> {settings.quality_max_size_gb:g} Go")
    if seeders < settings.quality_min_seeders:
        reject.append(f"< {settings.quality_min_seeders} seeders")

    if resolution.lower() == settings.quality_preferred_resolution.lower():
        score += 25
    if codec and any(codec.lower() == x.lower() for x in settings.preferred_codecs):
        score += 25
    if source and any(source.lower() == x.lower() for x in settings.allowed_sources):
        score += 15
    if settings.quality_required_language.upper() in name.upper():
        score += 25
    score += min(10, seeders / 5)

    return {
        "resolution": resolution, "codec": codec, "language": language,
        "source": source, "release_group": group,
        "accepted": not reject, "score": round(score, 1),
        "tmdb_match": tmdb_match,
        "rejection_reason": "; ".join(reject),
    }

def tmdb_search(q):
    if not settings.tmdb_api_key:
        raise RuntimeError("TMDB_API_KEY manquante")
    r = requests.get("https://api.themoviedb.org/3/search/movie",
        params={"api_key":settings.tmdb_api_key,"query":q,"language":"fr-FR","include_adult":"false"},
        timeout=20)
    r.raise_for_status()
    out=[]
    for x in r.json().get("results",[]):
        d=x.get("release_date") or ""
        year=int(d[:4]) if len(d)>=4 and d[:4].isdigit() else None
        out.append({"tmdb_id":x["id"],"title":x.get("title"),"original_title":x.get("original_title"),
                    "year":year,"poster_path":x.get("poster_path")})
    return out

def tmdb_get(tmdb_id):
    r = requests.get(f"https://api.themoviedb.org/3/movie/{tmdb_id}",
        params={"api_key":settings.tmdb_api_key,"language":"fr-FR"},timeout=20)
    r.raise_for_status()
    return _tmdb_movie_row(r.json())

def _tmdb_movie_row(x):
    d=x.get("release_date") or ""
    year=int(d[:4]) if len(d)>=4 and d[:4].isdigit() else None
    return {
        "tmdb_id":x["id"],"title":x.get("title"),"original_title":x.get("original_title"),
        "year":year,"poster_path":x.get("poster_path"),
        "release_date":d or None,
        "vote_average":round(float(x.get("vote_average") or 0),1),
        "vote_count":int(x.get("vote_count") or 0),
        "popularity":float(x.get("popularity") or 0),
        "overview":x.get("overview") or "",
    }

def tmdb_discover(release_gte=None, release_lte=None, min_rating=None, min_votes=None,
                  sort_by="popularity.desc", max_results=20, max_pages=3):
    if not settings.tmdb_api_key:
        raise RuntimeError("TMDB_API_KEY manquante")
    pages=max(1, min(int(max_pages or 3), (max(1, int(max_results))+19)//20))
    out, seen=[], set()
    for page in range(1, pages+1):
        params={
            "api_key":settings.tmdb_api_key,"language":"fr-FR","region":"FR",
            "include_adult":"false","include_video":"false",
            "sort_by":sort_by,"page":page,
        }
        if release_gte:
            params["primary_release_date.gte"]=release_gte
        if release_lte:
            params["primary_release_date.lte"]=release_lte
        if min_rating is not None:
            params["vote_average.gte"]=min_rating
        if min_votes is not None:
            params["vote_count.gte"]=min_votes
        r=requests.get("https://api.themoviedb.org/3/discover/movie",params=params,timeout=20)
        r.raise_for_status()
        for x in r.json().get("results") or []:
            tid=x.get("id")
            if not tid or tid in seen:
                continue
            seen.add(tid)
            out.append(_tmdb_movie_row(x))
            if len(out)>=max_results:
                return out
    return out

def _attr(item, name):
    for a in item.findall("torznab:attr", TORZNAB):
        if a.attrib.get("name")==name:
            return a.attrib.get("value","")
    return ""

def _attrs(item, name):
    return [
        a.attrib.get("value", "")
        for a in item.findall("torznab:attr", TORZNAB)
        if a.attrib.get("name") == name and a.attrib.get("value")
    ]

def _c411_throttle():
    global _last_c411
    if not settings.c411_api_key:
        raise RuntimeError("C411_API_KEY manquante")
    elapsed = time.monotonic() - _last_c411
    if _last_c411 and elapsed < settings.c411_request_delay_seconds:
        time.sleep(settings.c411_request_delay_seconds - elapsed)
    _last_c411 = time.monotonic()

def c411_query(params):
    """Appel Torznab C411. Respecte le délai entre requêtes."""
    _c411_throttle()
    q = {"apikey": settings.c411_api_key, **params}
    r = requests.get(settings.c411_endpoint, params=q, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    if root.tag == "error":
        raise RuntimeError(root.attrib.get("description") or "erreur C411")
    return root

def _parse_c411_item(item):
    name = (item.findtext("title") or "").strip()
    size = int(item.findtext("size") or 0)
    seeders = int(_attr(item, "seeders") or 0)
    peers = int(_attr(item, "peers") or 0)
    grabs_raw = _attr(item, "grabs") or _attr(item, "downloads") or "0"
    try:
        grabs = int(grabs_raw)
    except ValueError:
        grabs = 0
    tmdb_raw = _attr(item, "tmdbid") or _attr(item, "tmdb")
    tmdb_id = int(tmdb_raw) if tmdb_raw.isdigit() else None
    categories = []
    for raw in _attrs(item, "category"):
        if raw.isdigit():
            categories.append(int(raw))
    enc = item.find("enclosure")
    return {
        "title": name,
        "size_bytes": size,
        "seeders": seeders,
        "peers": peers,
        "grabs": grabs,
        "infohash": _attr(item, "infohash"),
        "tmdb_id": tmdb_id,
        "categories": categories,
        "download_url": enc.attrib.get("url", "") if enc is not None else "",
    }

_YEAR_RE = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
_QUALITY_IN_TITLE_RE = re.compile(
    r"(?i)\b(2160p|1080p|720p|576p|480p|4k|uhd|x265|h265|hevc|x264|h264|av1|"
    r"multi|french|truefrench|vff|vfq|vfi|vostfr|web-?dl|webrip|bluray|bdrip|brrip|"
    r"remux|hdtv|proper|repack|readnfo|extended|unrated|directors?|cut)\b"
)
_ARTICLES = {"a", "an", "the", "le", "la", "les", "un", "une", "des", "el", "l", "de", "du", "d", "of", "and", "et"}
_ROMAN = {"i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}
_EDITION_NOISE = {
    "extended", "unrated", "theatrical", "limited", "internal", "proper", "repack",
    "readnfo", "directors", "director", "cut", "edition", "version", "final",
    "imax", "hdr", "hdr10", "hdr10plus", "dv", "dolby", "vision", "atmos", "truehd",
    "truefrench", "vostfr", "vff", "vfq", "vfi", "multi", "french", "english",
    "subforced", "sub", "subs", "complete", "remastered", "remaster",
    "criterion", "ultimate", "special", "anniversary", "dc", "ddc",
    "2160p", "1080p", "720p", "576p", "480p", "4k", "uhd",
    "x265", "h265", "hevc", "x264", "h264", "av1", "xvid",
    "web", "webdl", "webrip", "bluray", "bdrip", "brrip", "hdtv", "remux", "dvdrip",
    "aac", "ac3", "dts", "eac3", "flac", "mp3", "10bit", "8bit",
}
_PACK_TOKENS = {
    "collection", "collections", "trilogy", "duology", "quadrilogy", "anthology",
    "pack", "integrale", "coffret", "saga", "bundle",
}

def clean_release_title(name):
    """Extrait un titre + année approximative depuis un nom de release C411."""
    stem = re.sub(r"[._]+", " ", name or "")
    years = list(_YEAR_RE.finditer(stem))
    # Le dernier millésime avant les tags scène est en général l'année du film
    # (ex. "2001 A Space Odyssey 1968", "Blade Runner 2049 2017").
    year = int(years[-1].group(1)) if years else None
    cut = years[-1].start() if years else len(stem)
    title = stem[:cut]
    title = _QUALITY_IN_TITLE_RE.sub(" ", title)
    title = re.sub(r"\s+", " ", title).strip(" -._")
    title = re.sub(r"\s*-\s*[A-Za-z0-9]{2,32}$", "", title).strip()
    return title, year

def _title_tokens(s):
    toks = []
    for t in norm(s).split():
        if t in _ARTICLES or t in _EDITION_NOISE:
            continue
        toks.append(_ROMAN.get(t, t))
    return toks

def _compact_title(s):
    """Titre sans espaces ni ponctuation (Don't / Dont / Don.t → dont)."""
    return norm(s).replace(" ", "")

def release_matches_tmdb(release_name, title, original_title=None, year=None):
    """Vérifie qu'une release C411 correspond au film TMDB (titre + année), pas à un voisin."""
    parsed_title, parsed_year = clean_release_title(release_name)
    if year and parsed_year and abs(int(year) - int(parsed_year)) > 1:
        return False, f"Année différente de TMDB ({parsed_year} vs {year})"

    rel_norm = norm(parsed_title)
    names = [c for c in (title, original_title) if c]
    # C411 est en ASCII scène ; TMDB garde les accents (« République » vs « Republique »)
    if rel_norm and any(rel_norm == norm(c) for c in names):
        return True, ""
    # Apostrophes / points scène : Don't ↔ Dont ↔ Don.t, Spider-Man ↔ SpiderMan
    rel_compact = _compact_title(parsed_title)
    if rel_compact and any(rel_compact == _compact_title(c) for c in names):
        return True, ""

    rel = _title_tokens(parsed_title)
    if any(t in _PACK_TOKENS for t in rel):
        return False, "Coffret / collection, pas le film TMDB"

    candidates = []
    for c in names:
        toks = _title_tokens(c)
        if toks and toks not in candidates:
            candidates.append(toks)
    if not rel or not candidates:
        return False, "Titre différent de la fiche TMDB"

    year_ok = not year or not parsed_year or abs(int(year) - int(parsed_year)) <= 1
    for mov in candidates:
        if rel == mov:
            return True, ""
        # Don't → [don, t] vs Dont → [dont] : mêmes lettres une fois recollées
        if "".join(rel) == "".join(mov):
            return True, ""
        # Release plus longue que TMDB → suite / autre film rattaché à la recherche
        if len(rel) > len(mov) and rel[:len(mov)] == mov:
            continue
        # Titre de release abrégé, acceptable seulement si l'année TMDB colle
        if year_ok and parsed_year and len(rel) >= 2 and len(mov) > len(rel) and mov[:len(rel)] == rel:
            return True, ""
    return False, "Titre différent de la fiche TMDB"

# Films, étrangers, animation, documentaires. Hors collections, clips, spectacles et concerts.
C411_FILM_CATS = {2000, 2030, 2060, 2070}
_SERIES_RE = re.compile(r"(?i)\bS\d{1,3}(?:E\d{1,3})?\b|\b(?:saison|season)\s*\d")

def c411_search(title, year=None, original_title=None, verify_tmdb=False):
    q=f"{title} {year}" if year else title
    root=c411_query({
        "t":"search","q":q,
        "cat":settings.c411_categories,"limit":100,
    })
    out=[]
    for item in root.findall("./channel/item"):
        row=_parse_c411_item(item)
        extra=score_release(
            row["title"], row["size_bytes"], row["seeders"],
            expected_title=title if verify_tmdb else None,
            expected_original=original_title if verify_tmdb else None,
            expected_year=year if verify_tmdb else None,
        )
        out.append({
            "title":row["title"],"size_bytes":row["size_bytes"],"seeders":row["seeders"],
            "leechers":max(0,row["peers"]-row["seeders"]),"infohash":row["infohash"],
            "download_url":row["download_url"],
            **extra
        })
    out.sort(key=lambda x:(x["accepted"],x["score"],x["seeders"]),reverse=True)
    return out

def c411_browse_movies(pages=5, page_size=100):
    """Derniers torrents films. Chaque page respecte le délai C411."""
    seen=set()
    out=[]
    for page in range(max(1, int(pages))):
        try:
            root=c411_query({
                "t":"search",
                "cat":",".join(str(c) for c in sorted(C411_FILM_CATS)),
                "limit":page_size,
                "offset":page * page_size,
                "extended":1,
            })
        except Exception:
            if page==0:
                raise
            break
        added=0
        for item in root.findall("./channel/item"):
            row=_parse_c411_item(item)
            key=(row.get("infohash") or "").lower() or row["title"]
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(row)
            added+=1
        if added==0:
            break
    return out

def aggregate_c411_completions(items):
    """Regroupe les releases d'un même film et additionne les complétions (grabs)."""
    groups={}
    for it in items:
        cats=it.get("categories") or []
        if cats and not any(c in C411_FILM_CATS for c in cats):
            continue
        name=it.get("title") or ""
        if _SERIES_RE.search(name):
            continue
        parsed, year=clean_release_title(name)
        if not parsed or any(t in _PACK_TOKENS for t in _title_tokens(parsed)):
            continue
        tid=it.get("tmdb_id") or None
        key=("id", tid) if tid else ("name", norm(parsed), year)
        g=groups.get(key)
        if not g:
            g={"tmdb_id":tid,"title":parsed,"year":year,"grabs":0,"releases":0}
            groups[key]=g
        g["grabs"]+=int(it.get("grabs") or 0)
        g["releases"]+=1
        if tid:
            g["tmdb_id"]=tid

    by_title={}
    for g in groups.values():
        if g["tmdb_id"]:
            by_title[(norm(g["title"]), g["year"])]=g
    drop=[]
    for key, g in groups.items():
        if g["tmdb_id"]:
            continue
        host=by_title.get((norm(g["title"]), g["year"]))
        if host is None and g.get("year"):
            host=by_title.get((norm(g["title"]), g["year"]+1)) or by_title.get((norm(g["title"]), g["year"]-1))
        if host and host is not g:
            host["grabs"]+=g["grabs"]
            host["releases"]+=g["releases"]
            drop.append(key)
    for key in drop:
        groups.pop(key, None)
    return sorted(groups.values(), key=lambda x:(x["grabs"], x["releases"]), reverse=True)

def c411_candidate_titles(q, limit=8):
    """Cherche sur C411 et déduit des titres de films à résoudre via TMDB."""
    releases = c411_search(q)
    seen = set()
    out = []
    for r in releases:
        title, year = clean_release_title(r["title"])
        if not title or len(title) < 2:
            continue
        key = (norm(title), year)
        if key in seen:
            continue
        seen.add(key)
        out.append({"title": title, "year": year, "seeders": r.get("seeders", 0), "release": r["title"]})
        if len(out) >= limit:
            break
    return out

class Transmission:
    def __init__(self):
        self.sid=None

    def rpc(self, method, arguments=None):
        headers={}
        if self.sid:
            headers["X-Transmission-Session-Id"]=self.sid
        auth=(settings.transmission_user,settings.transmission_password) if settings.transmission_user else None
        payload={"method":method,"arguments":arguments or {}}
        r=requests.post(settings.transmission_url,json=payload,headers=headers,auth=auth,timeout=20)
        if r.status_code==409:
            self.sid=r.headers.get("X-Transmission-Session-Id")
            headers["X-Transmission-Session-Id"]=self.sid
            r=requests.post(settings.transmission_url,json=payload,headers=headers,auth=auth,timeout=20)
        r.raise_for_status()
        data=r.json()
        if data.get("result") not in (None,"success"):
            raise RuntimeError(data.get("result") or "erreur Transmission")
        return data.get("arguments",{})

    def add_url(self, url):
        r=requests.get(url,timeout=30)
        r.raise_for_status()
        return self.rpc("torrent-add",{
            "metainfo":base64.b64encode(r.content).decode(),
            "paused":False,
            "download-dir":settings.transmission_download_dir
        })

    def list(self):
        fields=["id","name","hashString","percentDone","rateDownload","eta",
                "status","isFinished","leftUntilDone","errorString","sizeWhenDone"]
        try:
            return self.rpc("torrent-get",{"fields":fields}).get("torrents",[])
        except Exception:
            return self.rpc("torrent-get",{"fields":["id","name","hashString","percentDone","rateDownload","eta","status"]}).get("torrents",[])

TORRENT_STATUS={
    0:"En pause",1:"Vérification en attente",2:"Vérification",
    3:"En file",4:"Téléchargement",5:"Partage en attente",6:"Partage",
}

def torrent_incomplete(t):
    if t.get("isFinished") or t.get("status") in (5,6):
        return False
    percent=float(t.get("percentDone") or 0)
    if percent>=1:
        return False
    left=t.get("leftUntilDone")
    if left is not None and left<=0 and percent>0:
        return False
    return True

transmission=Transmission()
