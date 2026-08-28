import hashlib
import hmac
import time
from collections import defaultdict

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings

LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_ATTEMPTS = 8
PUBLIC_PATHS = {
    "/api/health",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
}

_login_attempts: dict[str, list[float]] = defaultdict(list)


class LoginIn(BaseModel):
    username: str
    password: str


def auth_enabled() -> bool:
    return bool(settings.auth_enable)


def _digest(value: str) -> bytes:
    return hashlib.sha256((value or "").encode("utf-8")).digest()


def _same(left: str, right: str) -> bool:
    return hmac.compare_digest(_digest(left), _digest(right))


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _login_blocked(ip: str) -> None:
    now = time.time()
    recent = [t for t in _login_attempts[ip] if now - t < LOGIN_WINDOW_SECONDS]
    _login_attempts[ip] = recent
    if len(recent) >= LOGIN_MAX_ATTEMPTS:
        raise HTTPException(429, "Trop de tentatives. Réessayez dans quelques minutes.")


def _record_login_failure(ip: str) -> None:
    _login_attempts[ip].append(time.time())


class RequireAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not auth_enabled() or request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
            return await call_next(request)
        if request.session.get("user"):
            response = await call_next(request)
        else:
            response = JSONResponse({"detail": "Authentification requise"}, status_code=401)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("Cache-Control", "no-store")
        return response


def install_auth(app: FastAPI) -> None:
    origins = [x.strip() for x in settings.auth_cors_origins.split(",") if x.strip()]
    if not origins:
        origins = ["http://localhost:5173"]

    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(RequireAuthMiddleware)
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        session_cookie="mm_session",
        same_site="lax",
        https_only=settings.auth_cookie_secure,
        max_age=settings.auth_session_days * 86400,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.post("/api/auth/login")
    def login(payload: LoginIn, request: Request):
        if not auth_enabled():
            raise HTTPException(503, "Authentification désactivée (AUTH_ENABLE=false).")
        if not (settings.auth_username and settings.auth_password):
            raise HTTPException(503, "AUTH_USERNAME / AUTH_PASSWORD manquants dans .env")
        _login_blocked(_client_ip(request))
        user_ok = _same(payload.username.strip(), settings.auth_username)
        pass_ok = _same(payload.password, settings.auth_password)
        if not (user_ok and pass_ok):
            _record_login_failure(_client_ip(request))
            raise HTTPException(401, "Identifiants incorrects")
        request.session.clear()
        request.session["user"] = settings.auth_username
        return {"ok": True, "username": settings.auth_username}

    @app.post("/api/auth/logout")
    def logout(request: Request):
        request.session.clear()
        return {"ok": True}

    @app.get("/api/auth/me")
    def me(request: Request):
        if not auth_enabled():
            return {"authenticated": True, "enabled": False, "username": None}
        user = request.session.get("user")
        if not user:
            raise HTTPException(401, "Authentification requise")
        return {"authenticated": True, "enabled": True, "username": user}
