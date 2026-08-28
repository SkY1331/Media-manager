# Media Manager

Application self-hosted pour gérer une bibliothèque de films :

- rechercher un film via [TMDb](https://www.themoviedb.org/) ;
- voir s’il est déjà présent dans la bibliothèque locale ;
- chercher des releases via un indexer Torznab (C411) ;
- filtrer (langue, résolution, codec, taille, seeders) ;
- envoyer une release à [Transmission](https://transmissionbt.com/) ;
- gérer une wishlist et une découverte automatique.

## Stack

- Frontend : React + Vite + TypeScript
- Backend : FastAPI (Python)
- Base : SQLite
- Orchestration : Docker Compose

## Prérequis

- [Docker](https://docs.docker.com/get-docker/) et Docker Compose v2
- Une clé API [TMDb](https://www.themoviedb.org/settings/api)
- Une clé API Torznab C411 (optionnelle tant que vous ne cherchez pas de releases)
- Transmission joignable depuis l’hôte Docker (RPC activé)

## Installation (Docker)

1. Cloner le dépôt et entrer dans le dossier :

```bash
git clone https://github.com/SkY1331/Media-manager.git
cd Media-manager
```

2. Créer la configuration à partir de l’exemple. **Ne commitez jamais `.env`.**

```bash
cp .env.example .env
```

Sous Windows (PowerShell) :

```powershell
Copy-Item .env.example .env
```

3. Éditer `.env` et renseigner au minimum :

```env
LIBRARY_HOST_PATH=/chemin/vers/votre/bibliotheque
TMDB_API_KEY=votre_cle_tmdb
C411_API_KEY=votre_cle_c411
TRANSMISSION_URL=http://host.docker.internal:9091/transmission/rpc
TRANSMISSION_DOWNLOAD_DIR=/chemin/vers/votre/dossier/telechargements
AUTH_USERNAME=admin
AUTH_PASSWORD=un-mot-de-passe-long-et-unique
SESSION_SECRET=collez-ici-le-secret
```

`LIBRARY_HOST_PATH` est le dossier **sur la machine qui lance Docker** (NAS, PC, serveur). Il est monté en lecture seule dans le conteneur.

Générer `SESSION_SECRET` :

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

4. Lancer :

```bash
docker compose up -d --build
```

5. Ouvrir l’interface : [http://localhost:5173](http://localhost:5173)

L’API n’est exposée que sur l’hôte (`127.0.0.1:8000`). Le frontend proxifie `/api` vers le backend. Swagger : [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

### Premier scan de bibliothèque

```bash
curl -X POST http://127.0.0.1:8000/api/library/scan
```

Le scan est incrémental (taille + date de modification mémorisées dans SQLite, volume `./data`).

## Variables d’environnement

| Variable | Rôle |
|---|---|
| `LIBRARY_HOST_PATH` | Chemin hôte de la bibliothèque films (volume Docker) |
| `LIBRARY_PATH` | Chemin **dans** le conteneur (`/media/movies`, à laisser tel quel) |
| `TMDB_API_KEY` | Clé TMDb |
| `C411_API_KEY` | Clé Torznab |
| `TRANSMISSION_URL` | URL RPC Transmission vue depuis le backend |
| `TRANSMISSION_USER` / `TRANSMISSION_PASSWORD` | Auth Transmission (si activée) |
| `TRANSMISSION_DOWNLOAD_DIR` | Dossier de téléchargement côté Transmission |
| `AUTH_ENABLE` | `true` recommandé |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | Identifiants de l’interface |
| `SESSION_SECRET` | Secret des cookies de session (unique) |
| `AUTH_COOKIE_SECURE` | `true` uniquement derrière HTTPS |
| `AUTH_CORS_ORIGINS` | Origines autorisées, séparées par des virgules |

Si vous ouvrez l’UI via une IP LAN ou un nom DNS, ajoutez-les à `AUTH_CORS_ORIGINS`, par exemple :

```env
AUTH_CORS_ORIGINS=http://localhost:5173,http://192.168.1.10:5173
```

## Accès distant

Ne pas ouvrir les ports `5173` ou `8000` sur Internet. Le mot de passe de l’app ne remplace ni le HTTPS ni un VPN.

**VPN maison (recommandé)** — se connecter au VPN, puis ouvrir `http://IP_LAN:5173`. Rien à exposer sur la box.

**Tailscale** — installer Tailscale sur l’hôte et le client, ouvrir `http://100.x.x.x:5173`. Laisser `AUTH_COOKIE_SECURE=false` tant que c’est du HTTP.

**Cloudflare Tunnel / reverse proxy HTTPS** — pointer le tunnel ou le proxy vers le frontend (`http://127.0.0.1:5173`). Passer `AUTH_COOKIE_SECURE=true`, ajouter l’URL HTTPS dans `AUTH_CORS_ORIGINS`, puis `docker compose up -d`.

## Sécurité

- Ne jamais committer `.env`, `./data` ni `docker-compose.override.yml`.
- Mot de passe d’app long, unique, différent du compte machine / NAS.
- Changer `SESSION_SECRET` déconnecte tout le monde.
- Firewall : n’autoriser `5173` que depuis le LAN (ou Tailscale). Ne pas publier `/docs` ni le port `8000`.
- `AUTH_ENABLE=true` avant toute ouverture réseau.

## Développement (hot-reload)

Pour recharger le code sans rebuild à chaque sauvegarde :

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
docker compose up -d --build
```

`docker-compose.override.yml` est ignoré par git (chemins et options locales).

## Limites (V0)

- Films uniquement.
- Le rapprochement du stock local repose sur titre + année parsés depuis le nom de fichier.
- Pas de déplacement / renommage automatique après téléchargement.
- Les URLs privées C411 ne sont pas persistées : elles sont rafraîchies au moment du téléchargement.
