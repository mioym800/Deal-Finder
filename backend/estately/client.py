import asyncio
import httpx
import os
from typing import Optional

DECODO_PROXY = os.getenv("DECODO_PROXY", "").strip()
HTTP_DEBUG = os.getenv("HTTP_DEBUG", "").lower() in {"1", "true", "yes"}

def _build_proxies():
    if not DECODO_PROXY:
        return None
    # httpx expects full scheme keys
    return {
        "http://": DECODO_PROXY,   # e.g. http://USER:PASS@us.decodo.com:10001
        "https://": DECODO_PROXY,
    }

def new_client(timeout: float = 30.0) -> httpx.AsyncClient:
    """
    Create a configured AsyncClient for Estately scraping with optional proxy and debug logging.
    Uses a robust connection pool and retries for transient network errors.
    """
    import logging
    http_debug = os.getenv("HTTP_DEBUG", "").lower() in {"1", "true", "yes"}
    if http_debug:
        logging.basicConfig(level=logging.DEBUG)
        httpx_logger = logging.getLogger("httpx")
        httpx_logger.setLevel(logging.DEBUG)

    limits = httpx.Limits(max_keepalive_connections=5, max_connections=10)
    transport = httpx.AsyncHTTPTransport(retries=2)
    return httpx.AsyncClient(
        timeout=timeout,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Cache-Control": "no-cache",
        },
        proxies=_build_proxies(),
        follow_redirects=True,
        http2=False,
        limits=limits,
        transport=transport,
    )
