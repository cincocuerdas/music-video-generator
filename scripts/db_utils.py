#!/usr/bin/env python3
"""
Shared database helpers for pipeline scripts.
"""
import os
from typing import Optional
from urllib.parse import urlparse

import psycopg2
from dotenv import load_dotenv
from runtime_config import is_production


current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
dotenv_path = os.path.join(root_dir, ".env")
load_dotenv(dotenv_path)


def sanitize_database_url(database_url: str) -> str:
    """Strip query params not supported by psycopg2."""
    value = (database_url or "").strip()
    if not value:
        raise Exception("DATABASE_URL not found in .env")
    if "?" in value:
        return value.split("?", 1)[0]
    return value


def validate_database_url(database_url: str) -> str:
    value = sanitize_database_url(database_url)
    if is_production():
        try:
            parsed = urlparse(value)
        except Exception as exc:
            raise RuntimeError(f"Invalid DATABASE_URL: {exc}") from exc

        hostname = (parsed.hostname or "").strip().lower()
        if hostname in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError(
                "DATABASE_URL cannot use loopback host in production.",
            )
    return value


def get_database_url(env_var: str = "DATABASE_URL") -> str:
    value = os.getenv(env_var)
    return validate_database_url(value or "")


def get_db_connection(database_url: Optional[str] = None):
    """Create psycopg2 connection from DATABASE_URL."""
    resolved = validate_database_url(database_url) if database_url else get_database_url()
    return psycopg2.connect(resolved)
