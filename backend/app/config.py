from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    app_name: str = "Les envies pour Plex"
    database_url: str = "sqlite:////data/media.db"
    library_path: str = "/media/movies"
    wishlist_interval_minutes: int = 360
    discovery_interval_minutes: int = 360
    discovery_min_rating: float = 7.0
    discovery_min_votes: int = 40
    discovery_released_days: int = 60
    discovery_upcoming_days: int = 90
    discovery_max_results: int = 20
    discovery_auto_add_nouveautes: bool = False
    discovery_auto_add_attendus: bool = False
    discovery_auto_add_classiques: bool = False
    discovery_auto_download: bool = False
    discovery_classic_min_rating: float = 8.0
    discovery_classic_min_votes: int = 1500
    discovery_classic_min_age_years: int = 10

    tmdb_api_key: str = ""

    c411_api_key: str = ""
    c411_endpoint: str = "https://c411.org/api/torznab"
    c411_categories: str = "2000,2010,2030,2050,2060,2070,2080,2090,5000,5060,5070,5080"
    c411_request_delay_seconds: float = 4.2

    quality_required_language: str = "MULTI"
    quality_preferred_resolution: str = "1080p"
    quality_preferred_codecs: str = "H265,x265,HEVC"
    quality_max_size_gb: float = 5.0
    quality_allowed_sources: str = "WEB-DL,WEBRip,BluRay,WEB"
    quality_min_seeders: int = 2

    transmission_url: str = "http://host.docker.internal:9091/transmission/rpc"
    transmission_user: str = ""
    transmission_password: str = ""
    transmission_download_dir: str = "/downloads"

    auth_enable: bool = False
    auth_username: str = ""
    auth_password: str = ""
    session_secret: str = "change-me-session-secret"
    auth_session_days: int = 7
    auth_cookie_secure: bool = False
    auth_cors_origins: str = "http://localhost:5173"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def preferred_codecs(self):
        return [x.strip() for x in self.quality_preferred_codecs.split(",") if x.strip()]

    @property
    def allowed_sources(self):
        return [x.strip() for x in self.quality_allowed_sources.split(",") if x.strip()]

settings = Settings()
