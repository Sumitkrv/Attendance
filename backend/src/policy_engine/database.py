import os
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker


def _resolve_policy_database_url() -> str:
    raw = (
        os.getenv("POLICY_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or ""
    ).strip()
    if raw:
        if raw.startswith("postgres://"):
            return raw.replace("postgres://", "postgresql+psycopg2://", 1)
        if raw.startswith("postgresql://"):
            return raw.replace("postgresql://", "postgresql+psycopg2://", 1)
        return raw

    # Safe local fallback for development when PostgreSQL env is not wired.
    return "sqlite:///policy_engine.db"


POLICY_DATABASE_URL = _resolve_policy_database_url()
engine = create_engine(
    POLICY_DATABASE_URL,
    future=True,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


@contextmanager
def get_session():
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def init_policy_db() -> None:
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
