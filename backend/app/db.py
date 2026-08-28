from sqlalchemy import create_engine, Column, Integer, String, BigInteger, Float, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime
from app.config import settings

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

class Movie(Base):
    __tablename__ = "movies"
    id = Column(Integer, primary_key=True)
    tmdb_id = Column(Integer, unique=True, index=True, nullable=True)
    title = Column(String, nullable=False, index=True)
    original_title = Column(String)
    year = Column(Integer, index=True)
    poster_path = Column(String)
    status = Column(String, default="MISSING")
    created_at = Column(DateTime, default=datetime.utcnow)

class LibraryFile(Base):
    __tablename__ = "library_files"
    id = Column(Integer, primary_key=True)
    path = Column(String, unique=True, nullable=False)
    filename = Column(String, nullable=False)
    size_bytes = Column(BigInteger, default=0)
    mtime = Column(Float)
    parsed_title = Column(String, index=True)
    parsed_year = Column(Integer, index=True)
    resolution = Column(String)
    codec = Column(String)
    language = Column(String)
    source = Column(String)
    release_group = Column(String)
    indexed_at = Column(DateTime, default=datetime.utcnow)

class Wishlist(Base):
    __tablename__ = "wishlist"
    id = Column(Integer, primary_key=True)
    movie_id = Column(Integer, ForeignKey("movies.id"), unique=True, nullable=False)
    auto_download = Column(Boolean, default=False)
    status = Column(String, default="WAITING")
    created_at = Column(DateTime, default=datetime.utcnow)
    last_checked_at = Column(DateTime)

class Release(Base):
    __tablename__ = "releases"
    id = Column(Integer, primary_key=True)
    movie_id = Column(Integer, ForeignKey("movies.id"), index=True)
    tracker = Column(String, default="C411")
    title = Column(String, nullable=False)
    size_bytes = Column(BigInteger, default=0)
    seeders = Column(Integer, default=0)
    leechers = Column(Integer, default=0)
    resolution = Column(String)
    codec = Column(String)
    language = Column(String)
    source = Column(String)
    release_group = Column(String)
    score = Column(Float, default=0)
    accepted = Column(Boolean, default=False)
    rejection_reason = Column(Text)
    infohash = Column(String, index=True)
    found_at = Column(DateTime, default=datetime.utcnow)

class Download(Base):
    __tablename__ = "downloads"
    id = Column(Integer, primary_key=True)
    movie_id = Column(Integer, ForeignKey("movies.id"))
    release_id = Column(Integer, ForeignKey("releases.id"))
    transmission_hash = Column(String, index=True)
    status = Column(String, default="DOWNLOADING")
    started_at = Column(DateTime, default=datetime.utcnow)

class AppSetting(Base):
    __tablename__ = "app_settings"
    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)

class DiscoveryIgnore(Base):
    __tablename__ = "discovery_ignore"
    tmdb_id = Column(Integer, primary_key=True)
    title = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

class DiscoveryAutoAdded(Base):
    __tablename__ = "discovery_auto_added"
    tmdb_id = Column(Integer, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)

Base.metadata.create_all(engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
