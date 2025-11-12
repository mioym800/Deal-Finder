from typing import List, Optional
from bs4 import BeautifulSoup
import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)
log = logging.getLogger("estately")
from backend.estately.client import new_client
from backend.estately.filters import build_search_url
try:
    from backend.estately.parsing import parse_card  # type: ignore
except Exception as _imp_err:
    log.warning("Falling back to basic parse_card due to import error: %s", _imp_err)
    import re
    def parse_card(card) -> dict:
        d = {}
        # super-basic fallback: try to find any address-like span and price
        addr = card.select_one("[data-testid*='address'], .ListingCard-address, span[itemprop='streetAddress']")
        d["address"] = addr.get_text(" ", strip=True) if addr else None
        loc = card.select_one(".ListingCard-location, [itemprop='addressLocality']")
        if loc:
            m = re.match(r"\s*([^,]+)\s*,\s*([A-Za-z]{2})(?:\s+(\d{5}))?", loc.get_text(" ", strip=True))
            if m:
                d["city"], d["state"], d["zip"] = m.group(1), m.group(2), m.group(3)
        price_el = card.select_one("[data-testid*='price'], .ListingCard-price, [itemprop='price']")
        if price_el:
            txt = re.sub(r"[^0-9.]", "", price_el.get_text(" ", strip=True))
            d["price"] = float(txt) if txt else None
        # Broaden link discovery – Estately often uses /ST/City/... paths without /listings/
        link_el = (
            card.select_one("a[href*='/listings/']") or
            card.select_one("a[href*='/home/']") or
            card.select_one("a[href*='/AZ/']") or  # common state/city pattern; harmless fallback
            card.select_one("a[href]")
        )
        d["href"] = link_el["href"] if link_el and link_el.has_attr("href") else None
        return d
from backend.py_models.property import PropertyCard

import os
import asyncio
import json
import re
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

# --- Helper: make_absolute ---
def make_absolute(base: str, href: str) -> str:
    """Return absolute URL for href, given base URL."""
    from urllib.parse import urljoin
    return urljoin(base, href)

# --- Helper: _harvest_from_detail ---
async def _harvest_from_detail(url: str, min_price: int = 0, min_beds: int = 0, min_sqft: int = 0) -> dict | None:
    """
    Fetch detail page and attempt to parse additional data from it.
    Returns a dict if successful, else None.
    """
    try:
        html = await fetch_html(url)
    except Exception as e:
        if ESTATELY_DEBUG:
            print(f"[estately] detail fetch failed: {e}")
        return None

    # Mine embedded JSON on the detail page; Estately is mostly client-rendered
    try:
        cand = _mine_inline_scripts(html) or []
    except Exception:
        cand = []

    for d in cand:
        if not _has_min_address(d):
            continue
        if not _passes_min(d.get("price"), min_price):
            continue
        if not _passes_min(d.get("beds"), min_beds):
            continue
        if not _passes_min(d.get("sqft"), min_sqft):
            continue
        d = dict(d)  # copy to avoid mutating shared object
        d.setdefault("href", url)
        return d
    return None


# --- MongoDB connection (aligns with Node schemas) ---
from datetime import datetime
try:
    from pymongo import MongoClient, UpdateOne  # type: ignore
except Exception:
    MongoClient = None  # type: ignore
    UpdateOne = None  # type: ignore

# --- MongoDB connection (aligns with Node schemas) ---
MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb+srv://mioymapp_db_user:sUdtApk9gnylGAV7@cluster0.ldjcoor.mongodb.net/deal_finder?retryWrites=true&w=majority",
)
try:
    if MongoClient is not None:
        _mongo_client = MongoClient(MONGO_URI)
        _mongo_db = _mongo_client["deal_finder"]
        _properties_col = _mongo_db["properties"]
    else:
        raise ImportError("pymongo not installed")
except Exception:
    _mongo_client = None
    _mongo_db = None
    _properties_col = None

# Try project wrapper first; if missing, fall back to raw Playwright.
try:
    from backend.privy.browser import launch_browser, new_page  # type: ignore
    from playwright.async_api import TimeoutError as PWTimeoutError  # type: ignore
    from playwright.async_api import Error as PWError  # type: ignore
    _PLAYWRIGHT_AVAILABLE = True
except Exception:
    try:
        # Direct Playwright fallback (no custom wrapper needed)
        from playwright.async_api import async_playwright, TimeoutError as PWTimeoutError  # type: ignore
        from playwright.async_api import Error as PWError  # type: ignore

        async def launch_browser():
            _p = await async_playwright().start()
            browser = await _p.chromium.launch(headless=True)
            # Stash the Playwright controller so we can stop it later.
            setattr(browser, "_playwright", _p)
            return browser

        async def new_page(browser):
            context = await browser.new_context()
            page = await context.new_page()
            return page

        _PLAYWRIGHT_AVAILABLE = True
    except Exception:
        launch_browser = None  # type: ignore
        new_page = None  # type: ignore
        PWTimeoutError = Exception  # type: ignore
        PWError = Exception  # type: ignore
        _PLAYWRIGHT_AVAILABLE = False

        
async def _collect_http_only(url: str,
                             min_price: int,
                             min_beds: int,
                             min_sqft: int,
                             require_distressed: bool,
                             require_no_hoa: bool) -> tuple[list[PropertyCard], list[dict], str | None]:
    results_out: list[PropertyCard] = []
    mongo_docs_out: list[dict] = []
    # Canonicalize the path then re-attach the original query so 301s don't drop filters
    try:
        parsed = urlparse(url)
        base_only = urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
        canonical = await resolve_canonical(base_only)
        url = reattach_query(canonical, url)
    except Exception as _canon_err:
        if ESTATELY_DEBUG:
            print(f"[estately] canonicalize failed; continuing with original: {_canon_err}")
    try:
        dom_html = await fetch_html(url)
    except Exception as http_err:
        print(f"[estately] HTTP fetch failed: {http_err}")
        return results_out, mongo_docs_out, None

    # Mine inline JSON from SSR and attempt to harvest listings
    inline_harvest = _mine_inline_scripts(dom_html)
    if inline_harvest and ESTATELY_DEBUG:
        print(f"[estately] harvested from INLINE (HTTP): {len(inline_harvest)}")

    seen_local = set()
    for d in inline_harvest or []:
        if not _passes_min(d.get("price"), min_price):
            continue
        if not _passes_min(d.get("beds"), min_beds):
            continue
        if not _passes_min(d.get("sqft"), min_sqft):
            continue
        # Require at least an address or (city+state) to avoid empty docs
        if not _has_min_address(d):
            if ESTATELY_DEBUG:
                print("[estately] skip inline: missing address/city/state")
            continue
        _st_txt, _is_active = _extract_status(d, d.get("_card_text") or "")
        if not _is_active:
            continue
        key = (d.get("address") or "", d.get("price") or 0)
        if key in seen_local:
            continue
        seen_local.add(key)
        results_out.append(PropertyCard(
            address=d.get("address") or "",
            city=d.get("city"),
            state=d.get("state"),
            zip=d.get("zip"),
            listing_price=d.get("price"),
            beds=d.get("beds"),
            baths=d.get("baths"),
            sqft=d.get("sqft"),
            source_url=(d.get("href") or url),
        ))
        doc = _normalize_property_from_dict(d, d.get("href") or url)
        doc.setdefault("agentName", doc.get("agent")); doc.setdefault("agentPhone", doc.get("agent_phone"))
        mongo_docs_out.append(doc)

    # DOM-based parse on the HTTP-fetched HTML
    try:
        soup_http = BeautifulSoup(dom_html, "lxml")
        sel_list = [
            ".js-map-listing-result",
            "div[data-testid*='MapResultsCard']",
            "div[class*='PropertyCard__wrapper']",
            "article[data-testid*='resultCard']",
            "a[href*='/home/']",
            "div[data-testid*='MapResults'] .js-map-listing-result",
            "div[id*='listings'] .js-map-listing-result",
            "[data-testid='listing-card']",
            "[data-qa='home-card']",
            "article.listingCard__wrapper",
            "article[class*='ListingCard']",
            "div[class*='PropertyCard']",
            "section[class*='HomeCard']",
            "li[class*='result'] article",
            "a[href*='/listings/']",
            "article",
        ]
        cards_http = soup_http.select(", ".join(sel_list)) or []
        if ESTATELY_DEBUG:
            print(f"[estately] HTTP DOM cards: {len(cards_http)}")
        seen_dom = set()
        for c in cards_http:
            try:
                data = parse_card(c)
            except Exception:
                continue

            # --- Normalize/enrich before gating by address ---
            if data.get("href"):
                data["href"] = make_absolute(url, data["href"])
            if not _has_min_address(data) and data.get("href"):
                try:
                    detail_data = await _harvest_from_detail(data["href"], min_price, min_beds, min_sqft)
                    if detail_data:
                        data.update(detail_data)
                except Exception:
                    if ESTATELY_DEBUG:
                        print("[estately] detail harvest failed")

            if not _passes_min(data.get("price"), min_price):
                continue
            if not _passes_min(data.get("beds"), min_beds):
                continue
            if not _passes_min(data.get("sqft"), min_sqft):
                continue
            # Require at least an address or (city+state)
            if not _has_min_address(data):
                if ESTATELY_DEBUG:
                    print("[estately] skip DOM: missing address/city/state")
                continue

            card_text = c.get_text(" ", strip=True)
            if require_no_hoa and not has_no_hoa(card_text):
                continue
            if require_distressed and not looks_distressed(card_text):
                continue

            _st_txt, _is_active = _extract_status(data, card_text)
            if not _is_active:
                continue

            key = (data.get("address") or "", data.get("price") or 0)
            if key in seen_dom:
                continue
            seen_dom.add(key)

            data["_card_text"] = card_text

            results_out.append(PropertyCard(
                address=data.get("address") or "",
                city=data.get("city"),
                state=data.get("state"),
                zip=data.get("zip"),
                listing_price=data.get("price"),
                beds=data.get("beds"),
                baths=data.get("baths"),
                sqft=data.get("sqft"),
                source_url=(data.get("href") or url),
            ))

            doc = _normalize_property_from_dict(data, data.get("href") or url)
            doc.setdefault("agentName", doc.get("agent")); doc.setdefault("agentPhone", doc.get("agent_phone"))
            mongo_docs_out.append(doc)
    except Exception as dom_fb_err:
        if ESTATELY_DEBUG:
            print(f"[estately] HTTP DOM parse failed: {dom_fb_err}")

    # Try to find next-page link
    next_a = None
    try:
        next_a = soup_http.select_one("a[rel='next'], a[aria-label='Next']")  # type: ignore[name-defined]
    except Exception:
        next_a = None
    next_url = None
    if next_a and next_a.get('href'):
        next_url = next_a['href']
        if next_url.startswith('/'):
            next_url = 'https://www.estately.com' + next_url

    return results_out, mongo_docs_out, next_url

DISTRESSED_KEYWORDS = ["foreclosure","pre-foreclosure","auction","bank owned","reo","short sale","fixer","distressed"]

ESTATELY_DEBUG = os.getenv("ESTATELY_DEBUG", "").lower() in {"1","true","yes"}

async def _capture_json_responses(page, bucket: list):
    async def _grab(resp):
        try:
            url = resp.url
        except Exception:
            url = ""
        # Heuristic: capture likely data endpoints regardless of content-type
        interesting = any(k in (url or "") for k in [
            "search", "listing", "listings", "results", "graphql", "homes", "api", "inventory", "properties"
        ])
        if not interesting:
            return
        try:
            text = await resp.text()
            if not text:
                return
            if ESTATELY_DEBUG:
                fname = f"/tmp/estately_net_{abs(hash(url))}.txt"
                try:
                    with open(fname, "w", encoding="utf-8", errors="ignore") as f:
                        f.write(text)
                    print(f"[estately] saved NET → {fname} :: {url}")
                except Exception:
                    pass
            bucket.append({"url": url, "text": text})
        except Exception:
            pass
    page.on("response", lambda r: asyncio.create_task(_grab(r)))

_phone_re = re.compile(r"(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}")
_email_re = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

# --- Status helpers ---
NEG_STATUS = {"pending","sold","contingent","off market","off-market","closed","withdrawn","canceled","leased","rented","temporarily off market"}
POS_STATUS_TOKENS = {"for sale","active","active listing","on market","on-market"}

def _extract_status(d: dict, text: str = "") -> tuple[Optional[str], bool]:
    """Return (normalized_status_text, is_active_for_sale). Uses dict hints + card text."""
    status_fields = [
        "status","listingStatus","propertyStatus","marketStatus","statusText","saleType","listing_type","onMarket","isActive","forSale"
    ]
    raw = None
    for k in status_fields:
        if k in d and d[k] is not None:
            raw = d[k]
            break
    s = str(raw).strip().lower() if raw is not None else ""
    blob = " ".join([s, (text or "").lower()]).strip()
    # boolean style fields
    if isinstance(raw, bool):
        is_active = bool(raw)
    else:
        if any(tok in blob for tok in NEG_STATUS):
            is_active = False
        elif any(tok in blob for tok in POS_STATUS_TOKENS):
            is_active = True
        else:
            # default to true when unknown (we'll still gate with text later where available)
            is_active = True
    return (s or None), is_active

def _extract_contacts(text: str) -> tuple[Optional[str], Optional[str]]:
    t = text or ""
    phone = None
    email = None
    m = _phone_re.search(t)
    if m:
        phone = m.group(0)
    m = _email_re.search(t)
    if m:
        email = m.group(0)
    return phone, email
def _normalize_property_from_dict(d: dict, source_url: str = "") -> dict:
    address = (d.get("address") or "").strip()
    city = (d.get("city") or "").strip()
    state = (d.get("state") or "").strip().upper()
    zipc = str(d.get("zip") or "").strip()

    full_addr_parts = []
    if address:
        full_addr_parts.append(address)
    loc_tail = " ".join(p for p in [state, zipc] if p).strip()
    if city or loc_tail:
        full_addr_parts.append(", ".join(p for p in [city, loc_tail] if p))
    full_addr = ", ".join(full_addr_parts).strip(", ")

    # Agent / broker best-effort extraction from multiple possible keys
    agent = (
        d.get("agent") or d.get("agentName") or d.get("listingAgent") or d.get("agent_name")
    )
    broker = (
        d.get("broker") or d.get("brokerage") or d.get("officeName") or d.get("broker_name")
    )
    agent_phone = d.get("agent_phone") or d.get("agentPhone") or d.get("listingAgentPhone")
    agent_email = d.get("agent_email") or d.get("agentEmail") or d.get("listingAgentEmail")
    broker_phone = d.get("broker_phone") or d.get("officePhone")
    broker_email = d.get("broker_email")

    # If we were passed a blob of card text, attempt to mine phone/email
    if not agent_phone or not agent_email:
        text_blob = d.get("_card_text") or ""
        ph, em = _extract_contacts(text_blob)
        agent_phone = agent_phone or ph
        agent_email = agent_email or em

    # --- Status extraction ---
    status_text, is_active = _extract_status(d, d.get("_card_text") or "")

    price_val = d.get("price")
    try:
        price_val = float(price_val) if price_val is not None else None
    except Exception:
        price_val = None

    beds_val = d.get("beds")
    baths_val = d.get("baths")
    sqft_val = d.get("sqft")

    # Build Mongo document mirroring your Node schemas
    doc = {
        "fullAddress": full_addr,
        "fullAddress_ci": (full_addr or "").lower(),
        "address": address,
        "city": city,
        "state": state,
        "zip": zipc,
        "price": price_val,
        "details": {
            "beds": beds_val,
            "baths": baths_val,
            "sqft": sqft_val,
            "_raw": {k: v for k, v in d.items() if k != "_card_text"},
        },
        "agent": agent,
        "agent_phone": agent_phone,
        "agent_email": agent_email,
        "broker": broker,
        "broker_phone": broker_phone,
        "broker_email": broker_email,
        "listing_status": status_text or "active",
        "status": "active" if is_active else "inactive",
        "forSale": bool(is_active),
        "isActive": bool(is_active),
        "source_url": source_url,
        "scrapedAt": datetime.utcnow(),
    }
    try:
        log.info(
            "SCRAPE ✔ %s | $%s | beds=%s baths=%s sqft=%s | %s",
            doc.get("fullAddress"),
            doc.get("price"),
            doc["details"].get("beds"),
            doc["details"].get("baths"),
            doc["details"].get("sqft"),
            source_url,
        )
    except Exception:
        pass
    return doc

def _flatten_dicts(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _flatten_dicts(v)
    elif isinstance(obj, list):
        for it in obj:
            yield from _flatten_dicts(it)

def _coerce_float(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x)
    s = re.sub(r"[^0-9.]", "", s)
    try:
        return float(s) if s else None
    except Exception:
        return None

def _has_min_address(d: dict) -> bool:
    """Return True if we have enough location info to keep the card."""
    if not isinstance(d, dict):
        return False
    addr = (d.get("address") or "").strip()
    city = (d.get("city") or "").strip()
    state = (d.get("state") or "").strip()
    return bool(addr or (city and state))

def _passes_min(val, minimum):
    """
     Return True if the (possibly messy) value meets or exceeds the minimum.
    If the value is missing/unknown, we keep the listing (return True).
    """
    v = _coerce_float(val)
    if v is None:
        return True
    return v >= minimum
    
    
ACTIVE_TOKENS = {
    "active", "for_sale", "for sale", "active-listing", "on_market", "on market"
}
INACTIVE_TOKENS = {
    "pending", "under contract", "contingent", "off_market", "sold",
    "coming soon", "withdrawn", "canceled", "expired"
}

def _looks_active_for_sale(d: dict) -> bool:
    """
    Best-effort read of status-ish fields.
    """
    status_fields = [
        "status", "listingStatus", "sale_status", "marketStatus", "availability",
        "listing_status", "mlsStatus", "property_status", "propStatus"
    ]
    val = None
    for f in status_fields:
        v = d.get(f)
        if v:
            val = str(v).strip().lower()
            break
    if not val:
        # If no status at all, assume active (many feed fragments omit it)
        return True
    if any(tok in val for tok in INACTIVE_TOKENS):
        return False
    if any(tok in val for tok in ACTIVE_TOKENS):
        return True
    # Unknown token → keep (erring on active)
    return True

def _addr_from_any(d: dict) -> dict | None:
    """
    Normalize address from a variety of common shapes used by real estate feeds.
    """
    if not isinstance(d, dict):
        return None
    # nested address node?
    cand = d.get("address") or d.get("location") or d.get("propertyAddress") or d.get("address_obj")
    if isinstance(cand, dict):
        d2 = cand
    else:
        d2 = d

    address = (
        d2.get("address") or d2.get("streetAddress") or d2.get("street_address") or
        d2.get("line1") or d2.get("addressLine1") or d2.get("address1")
    )
    city = d2.get("city") or d2.get("addressCity")
    state = d2.get("state") or d2.get("addressState") or d2.get("stateCode")
    zipc = d2.get("zip") or d2.get("zipcode") or d2.get("postalCode") or d2.get("zip_code")

    if address or (city and state):
        return {"address": address, "city": city, "state": state, "zip": zipc}
    return None


def _extract_listings_from_json_blob(text: str) -> list[dict]:
    """
    Walk any JSON tree, pull out objects that look like Estately-style listings.
    Expanded to handle a wide variety of real-estate JSON structures.
    Prints debug info if ESTATELY_DEBUG is set.
    """
    try:
        # Some endpoints may return HTML or anti-JSON shields; reject obvious HTML and strip shields.
        low = text.lower()
        if "<html" in low or "<!doctype" in low:
            return []
        t = text.strip()
        for prefix in ("for(;;);", ")]}'", ")]}',", "while(1);"):
            if t.startswith(prefix):
                t = t[len(prefix):].lstrip()
        first_brace = min([i for i in [t.find("{"), t.find("[")] if i != -1] or [-1])
        if first_brace > 0:
            t = t[first_brace:]
        data = json.loads(t)
    except Exception:
        if ESTATELY_DEBUG:
            print("[estately] Could not parse JSON blob")
        return []

    def _price_from_any(d: dict):
        # Handles cents and dollar fields
        raw = (
            d.get("listPrice") or d.get("price") or d.get("displayPrice") or
            d.get("list_price") or d.get("listPriceCents") or d.get("priceCents") or
            d.get("list_price_cents") or d.get("price_cents")
        )
        if raw is None:
            return None
        # cents?
        try:
            if isinstance(raw, (int, float)) and raw > 0 and raw < 100000:
                # check presence of *_cents keys
                pass
        except Exception:
            pass
        cents_keys = {"listPriceCents", "priceCents", "list_price_cents", "price_cents"}
        for k in cents_keys:
            if k in d and d[k] == raw:
                return float(raw) / 100.0
        return _coerce_float(raw)

    def _href_from_any(d: dict):
        return (
            d.get("url") or d.get("detailUrl") or d.get("permalink") or
            d.get("canonicalUrl") or d.get("seoUrl") or d.get("listingUrl")
        )

    out = []
    seen_keys = set()
    for node in _flatten_dicts(data):
        if not isinstance(node, dict):
            continue
        addr = _addr_from_any(node)
        price = _price_from_any(node)
        if not addr or price is None:
            continue
        if not _looks_active_for_sale(node):
            continue
        beds = (
            node.get("beds") or node.get("bedrooms") or node.get("num_bedrooms") or
            node.get("bedCount")
        )
        baths = (
            node.get("baths") or node.get("bathrooms") or node.get("fullBaths") or
            node.get("bathCount")
        )
        sqft = (
            node.get("sqft") or node.get("livingArea") or node.get("squareFeet") or
            node.get("square_feet") or node.get("living_area")
        )
        href = _href_from_any(node)
        key = (
            (addr.get("address") or "").strip().lower(),
            _coerce_float(price) or 0.0,
            (addr.get("zip") or addr.get("zipcode") or addr.get("zip_code") or "")
        )
        if key in seen_keys:
            continue
        seen_keys.add(key)
        listing = {
            "address": (addr.get("address") or "").strip(),
            "city": None if addr.get("city") is None else str(addr.get("city")),
            "state": None if addr.get("state") is None else str(addr.get("state")),
            "zip": None if addr.get("zip") is None else str(addr.get("zip")),
            "price": _coerce_float(price),
            "beds": _coerce_float(beds),
            "baths": _coerce_float(baths),
            "sqft": int(_coerce_float(sqft) or 0) if _coerce_float(sqft) is not None else None,
            "href": None if href is None else str(href),
        }
        if ESTATELY_DEBUG:
            print(f"[estately] harvested listing: {listing}")
        out.append(listing)
    return out


# --- Targeted parser for Estately /map/properties endpoint ---
def _extract_estately_map_properties(url: str, text: str) -> list[dict]:
    """
    Targeted parser for Estately's /map/properties endpoint, which returns a JSON array
    of listing dicts with nested address fields and price in cents.
    """
    try:
        if "/map/properties" not in (url or ""):
            return []
        data = json.loads(text)
        if not isinstance(data, (list, tuple)):
            return []
    except Exception:
        return []

    out = []
    for it in data:
        if not isinstance(it, dict):
            continue
        addr_obj = it.get("address") or {}
        street = addr_obj.get("street") or addr_obj.get("address") or it.get("streetAddress")
        city = addr_obj.get("city") or it.get("city")
        state = addr_obj.get("state") or it.get("state")
        zipc = addr_obj.get("zip") or addr_obj.get("zipcode") or addr_obj.get("postalCode") or it.get("zip")

        # price may be in cents
        price = it.get("list_price") or it.get("price") or it.get("list_price_cents") or it.get("price_cents")
        if isinstance(price, (int, float)) and price > 0 and price < 100000:  # likely cents
            price = float(price)
        # normalize possible cents keys
        if "list_price_cents" in it and isinstance(it["list_price_cents"], (int, float)):
            price = float(it["list_price_cents"]) / 100.0
        elif "price_cents" in it and isinstance(it["price_cents"], (int, float)):
            price = float(it["price_cents"]) / 100.0
        else:
            price = _coerce_float(price)

        beds = it.get("beds") or it.get("bedrooms") or it.get("bed_count")
        baths = it.get("baths") or it.get("bathrooms") or it.get("bath_count")
        sqft = it.get("sqft") or it.get("square_feet") or it.get("living_area")
        href = it.get("url") or it.get("listing_url") or it.get("permalink")

        # status filtering (prefer explicit field if present)
        st_txt, is_active = _extract_status(it, "")
        if not is_active:
            continue

        # Require a minimally sane address + price
        if not (street and (city or state)) or price is None:
            continue

        out.append({
            "address": (street or "").strip(),
            "city": None if city is None else str(city),
            "state": None if state is None else str(state),
            "zip": None if zipc is None else str(zipc),
            "price": _coerce_float(price),
            "beds": _coerce_float(beds),
            "baths": _coerce_float(baths),
            "sqft": int(_coerce_float(sqft) or 0) if _coerce_float(sqft) is not None else None,
            "href": None if href is None else str(href),
        })
    if ESTATELY_DEBUG:
        print(f"[estately] harvested (targeted) /map/properties: {len(out)}")
    return out


async def _progressive_scroll(page, steps: int = 6, wait_ms: int = 600):
    for _ in range(steps):
        await page.evaluate("window.scrollBy(0, document.body.scrollHeight)")
        await page.wait_for_timeout(wait_ms)

async def _dismiss_banners(page):
    for text in ["OK","Accept","I agree","Got it"]:
        try:
            await page.locator(f"text={text}").first.click(timeout=1500)
            break
        except Exception:
            pass

async def _prime_results(page):
    try:
        await page.locator("text=Click to see homes here").first.click(timeout=2000)
    except Exception:
        pass
    try:
        toggle = page.locator("button:has-text('Map')")
        if await toggle.count() > 0:
            await toggle.first.click()
            await page.locator("text=List").first.click(timeout=1500)
    except Exception:
        pass

async def _wait_for_listings(page) -> None:
    # wait for any common card selector to appear; try scroll-assisted waits
    selectors = [
        ".js-map-listing-result",
        "div[data-testid*='MapResultsCard']",
        "div[class*='PropertyCard__wrapper']",
        "article[data-testid*='resultCard']",
        "a[href*='/home/']",
        "div[data-testid*='MapResults'] .js-map-listing-result",
        "div[id*='listings'] .js-map-listing-result",
        "[data-testid='listing-card']",
        "[data-qa='home-card']",
        "article.listingCard__wrapper",
        "article[class*='ListingCard']",
        "div[class*='PropertyCard']",
        "section[class*='HomeCard']",
        "li[class*='result'] article",
        "a[href*='/listings/']",
        "article",
    ]
    for _ in range(4):
        for sel in selectors:
            try:
                await page.wait_for_selector(sel, timeout=3000)
                return
            except PWTimeoutError:
                pass
        await _progressive_scroll(page, steps=2, wait_ms=500)
    # final attempt
    await page.wait_for_selector(selectors[-1], timeout=5000)
    await _progressive_scroll(page, steps=2, wait_ms=400)

def _mine_inline_scripts(html: str) -> list[dict]:
    # Try to find embedded JSON blobs in <script> tags
    soup = BeautifulSoup(html, "lxml")
    blobs = []
    for s in soup.find_all("script"):
        typ = (s.get("type") or "").lower()
        if typ in ("application/json", "application/ld+json") or (not typ and s.string and "{" in s.string):
            try:
                txt = s.string or s.get_text() or ""
                # Some apps wrap JSON in window.__STATE__=...
                # Strip assignment-like prefixes
                if "{" not in txt:
                    continue
                start = txt.find("{")
                candidate = txt[start:]
                # Properly trim trailing JS or HTML after JSON by matching braces/brackets
                end_brace = None
                stack = []
                for i, ch in enumerate(candidate):
                    if ch == "{" or ch == "[":
                        stack.append(ch)
                    elif ch == "}" or ch == "]":
                        if stack:
                            stack.pop()
                        if not stack:
                            end_brace = i
                            break
                if end_brace is not None:
                    candidate = candidate[:end_brace + 1]
                data = json.loads(candidate)
                blobs.append(data)
            except Exception:
                continue
    # Flatten into listing-ish dicts
    out = []
    for data in blobs:
        try:
            text = json.dumps(data)
            out.extend(_extract_listings_from_json_blob(text))
        except Exception:
            pass
    return out


def reattach_query(canonical_url: str, original_url: str) -> str:
    """
    Take the canonical path and re-attach original query params (merged).
    If the canonical already has params, merge and prefer the original ones.
    """
    c = urlparse(canonical_url)
    o = urlparse(original_url)
    c_q = dict(parse_qsl(c.query))
    o_q = dict(parse_qsl(o.query))
    merged = {**c_q, **o_q}
    return urlunparse((c.scheme, c.netloc, c.path, c.params, urlencode(merged, doseq=True), c.fragment))

async def resolve_canonical(base_url: str) -> str:
    """
    Follow redirects for a URL without query parameters, returning the final canonical URL.
    We intentionally omit the query so we can re-attach the original filters after normalization.
    """
    try:
        async with new_client() as client:
            r = await client.get(base_url)
            return str(r.url)
    except Exception:
        return base_url

async def fetch_html(url: str) -> str:
    """
    Fetch a URL. When ESTATELY_DEBUG is set, save the body under /tmp so we can
    inspect selectors offline (works for both HTTP-only and PW fallbacks).
    """
    async with new_client() as client:
        r = await client.get(url)
        r.raise_for_status()
        text = r.text

        if ESTATELY_DEBUG:
            try:
                # Include url + length to avoid collisions across redirects/content changes
                h = abs(hash(f"{url}|{len(text)}"))
                fname = f"/tmp/estately_http_{h}.html"
                with open(fname, "w", encoding="utf-8", errors="ignore") as f:
                    f.write(text)
                print(f"[estately] saved HTTP → {fname} :: {url}")
            except Exception as _save_err:
                print(f"[estately] debug save failed: {_save_err}")

        return text

def looks_distressed(text: str) -> bool:
    t = (text or "").lower()
    return any(k in t for k in DISTRESSED_KEYWORDS)

def has_no_hoa(text: str) -> bool:
    # If card shows HOA $... we exclude. SSR sometimes prints 'HOA $...'
    return "hoa" not in (text or "").lower()

async def collect_estately(
    market: str,
    max_pages: int = 2,
    min_price: int = 600000,
    min_beds: int = 3,
    min_sqft: int = 1000,
    require_distressed: bool = False,
    require_no_hoa: bool = False,
) -> List[PropertyCard]:
    results: List[PropertyCard] = []
    mongo_docs: list[dict] = []
    seen = set()

    url = build_search_url(
    market,
    min_price=min_price,
    min_beds=min_beds,
    min_sqft=min_sqft,
    no_hoa=require_no_hoa,
    distressed=require_distressed,
)
    # If Playwright is unavailable, run a pure HTTP fallback for up to max_pages
    if not _PLAYWRIGHT_AVAILABLE or launch_browser is None or new_page is None:  # type: ignore
        print("[estately] Playwright not installed; running HTTP-only mode.")
        for page_idx in range(max_pages):
            page_results, page_docs, next_url = await _collect_http_only(
                url,
                min_price,
                min_beds,
                min_sqft,
                require_distressed,
                require_no_hoa,
            )
            results.extend(page_results)
            mongo_docs.extend(page_docs)
            if not next_url:
                break
            url = next_url
        # Persist if possible, then return
        if (_properties_col is not None) and mongo_docs:
            try:
                ops = [
                    UpdateOne(
                        {"fullAddress_ci": d["fullAddress_ci"]},
                        {"$set": d},
                        upsert=True,
                    )
                    for d in mongo_docs
                    if d.get("fullAddress_ci")
                ]
                if ops:
                    res = _properties_col.bulk_write(ops, ordered=False)
                    log.info(
                        "DB UPSERT BULK | ops=%d upserted=%d modified=%d matched=%d",
                        len(ops),
                        getattr(res, "upserted_count", 0),
                        getattr(res, "modified_count", 0),
                        getattr(res, "matched_count", 0),
                    )
            except Exception as e:
                print(f"[estately] Mongo upsert failed (HTTP-only): {e}")
        if ESTATELY_DEBUG:
            print(f"[estately] FINAL persist summary (HTTP-only): results={len(results)} mongo_docs={len(mongo_docs)}")
        return results

    browser = await launch_browser()
    try:
        page = await new_page(browser)
        net_bucket: list = []
        await _capture_json_responses(page, net_bucket)
        for page_idx in range(max_pages):
            try:
                await page.goto(url, wait_until="domcontentloaded")
            except PWError as nav_err:
                # Network/proxy issues (e.g., net::ERR_TUNNEL_CONNECTION_FAILED). Fallback to HTTP-only scrape.
                print(f"[estately] page.goto failed; falling back to HTTP fetch: {nav_err}")
                try:
                    dom_html = await fetch_html(url)
                except Exception as http_err:
                    print(f"[estately] HTTP fallback also failed: {http_err}")
                    raise

                # Mine inline JSON from SSR and attempt to harvest listings
                inline_harvest = _mine_inline_scripts(dom_html)
                if inline_harvest and ESTATELY_DEBUG:
                    print(f"[estately] harvested from INLINE (HTTP fallback): {len(inline_harvest)}")

                seen_fallback = set()
                for d in inline_harvest or []:
                    if not _passes_min(d.get("price"), min_price):
                        continue
                    if not _passes_min(d.get("beds"), min_beds):
                        continue
                    if not _passes_min(d.get("sqft"), min_sqft):
                        continue
                    _st_txt, _is_active = _extract_status(d, d.get("_card_text") or "")
                    if not _is_active:
                        continue
                    key = (d.get("address") or "", d.get("price") or 0)
                    if key in seen_fallback:
                        continue
                    seen_fallback.add(key)
                    results.append(PropertyCard(
                        address=d.get("address") or "",
                        city=d.get("city"),
                        state=d.get("state"),
                        zip=d.get("zip"),
                        listing_price=d.get("price"),
                        beds=d.get("beds"),
                        baths=d.get("baths"),
                        sqft=d.get("sqft"),
                        source_url=(d.get("href") or url),
                    ))
                    doc = _normalize_property_from_dict(d, d.get("href") or url)
                    # duplicate common agent keys for Node schemas (non-breaking)
                    doc.setdefault("agentName", doc.get("agent")); doc.setdefault("agentPhone", doc.get("agent_phone"))
                    mongo_docs.append(doc)

                # If fallback produced any docs, persist and return immediately.
                if (_properties_col is not None) and mongo_docs:
                    try:
                        ops = [
                            UpdateOne(
                                {"fullAddress_ci": d["fullAddress_ci"]},
                                {"$set": d},
                                upsert=True,
                            )
                            for d in mongo_docs
                            if d.get("fullAddress_ci")
                        ]
                        if ops:
                            res = _properties_col.bulk_write(ops, ordered=False)
                            log.info(
                                "DB UPSERT BULK | ops=%d upserted=%d modified=%d matched=%d",
                                len(ops),
                                getattr(res, "upserted_count", 0),
                                getattr(res, "modified_count", 0),
                                getattr(res, "matched_count", 0),
                            )
                            if ESTATELY_DEBUG:
                                print(f"[estately] upserted {len(ops)} docs into MongoDB (HTTP fallback)")
                    except Exception as e:
                        print(f"[estately] Mongo upsert failed (HTTP fallback): {e}")

                return results
            await _dismiss_banners(page)
            await _prime_results(page)
            await page.wait_for_timeout(1000)
            try:
                await _wait_for_listings(page)
            except Exception:
                # keep going; we'll still snapshot HTML
                pass

            # small extra scroll to ensure cards are in DOM
            await _progressive_scroll(page, steps=2, wait_ms=400)

            # Give the app a moment to fire network requests
            await page.wait_for_timeout(800)

            if ESTATELY_DEBUG:
                print(f"[estately] net blobs so far: {len(net_bucket)}")

            # If DOM path fails, try network-captured JSON
            dom_cards = []
            try:
                dom_html = await page.content()
                if ESTATELY_DEBUG:
                    try:
                        h = abs(hash(f"{url}|{len(dom_html)}"))
                        fname = f"/tmp/estately_dom_{h}.html"
                        with open(fname, "w", encoding="utf-8", errors="ignore") as f:
                            f.write(dom_html)
                        print(f"[estately] saved DOM → {fname} :: {url}")
                    except Exception:
                        pass
                soup_dom = BeautifulSoup(dom_html, "lxml")
                dom_cards = soup_dom.select(", ".join([
                    ".js-map-listing-result",
                    "div[data-testid*='MapResultsCard']",
                    "div[class*='PropertyCard__wrapper']",
                    "article[data-testid*='resultCard']",
                    "a[href*='/home/']",
                    "div[data-testid*='MapResults'] .js-map-listing-result",
                    "div[id*='listings'] .js-map-listing-result",
                    "[data-testid='listing-card']",
                    "[data-qa='home-card']",
                    "article.listingCard__wrapper",
                    "article[class*='ListingCard']",
                    "div[class*='PropertyCard']",
                    "section[class*='HomeCard']",
                    "li[class*='result'] article",
                    "a[href*='/listings/']",
                    "article",
                ])) or [] or []
            except Exception:
                dom_cards = []

            soup = None
            cards = dom_cards
            if not cards and net_bucket:
                harvested = []
                for blob in net_bucket[-20:]:
                    url_b = blob.get("url") or ""
                    txt_b = blob.get("text") or ""
                    # Use targeted Estately /map/properties parser first
                    h1 = _extract_estately_map_properties(url_b, txt_b)
                    if h1:
                        harvested.extend(h1)
                        continue
                    # Fallback: generic JSON walker
                    harvested.extend(_extract_listings_from_json_blob(txt_b))
                if harvested and ESTATELY_DEBUG:
                    print(f"[estately] harvested from NET: {len(harvested)}")
                    
                if harvested:
                    for d in harvested:
                        if (d.get("price") or 0) < min_price: 
                            continue
                        if not _passes_min(d.get("beds"), min_beds): 
                            continue
                        if not _passes_min(d.get("sqft"), min_sqft): 
                            continue
                        extra_text = ""
                        if require_no_hoa and not has_no_hoa(extra_text):
                            continue
                        if require_distressed and not looks_distressed(extra_text):
                            continue
                        # Ensure active & for-sale
                        _st_txt, _is_active = _extract_status(d)
                        if not _is_active:
                            continue

                        # Best-effort: carry any agent/broker info forward into Mongo doc shape
                        # (Handled more fully by _normalize_property_from_dict, but add common aliases here)
                        if "agentName" not in d and "agent" in d:
                            d["agentName"] = d.get("agent")
                        if "agentPhone" not in d and "agent_phone" in d:
                            d["agentPhone"] = d.get("agent_phone")

                        key = (d.get("address") or "", d.get("price") or 0)
                        if key in seen:
                            continue
                        seen.add(key)
                        results.append(PropertyCard(
                            address=d.get("address") or "",
                            city=d.get("city"),
                            state=d.get("state"),
                            zip=d.get("zip"),
                            listing_price=d.get("price"),
                            beds=d.get("beds"),
                            baths=d.get("baths"),
                            sqft=d.get("sqft"),
                            source_url=(d.get("href") or url),
                        ))
                        doc = _normalize_property_from_dict(d, d.get("href") or url)
                        mongo_docs.append(doc)
                    # Advance to next page if we already built results from JSON
                    # Continue loop without DOM parsing below
                    if results:
                        # try to find a next URL from DOM; otherwise break
                        html = await page.content()
                        soup = BeautifulSoup(html, "lxml")
                        next_a = soup.select_one('a[rel="next"], a[aria-label="Next"]')
                        if not next_a or not next_a.get('href'):
                            break
                        next_href = next_a['href']
                        if next_href.startswith('/'): 
                            next_href = 'https://www.estately.com' + next_href
                        url = next_href
                        continue

            if not cards and not results:
                inline_harvest = _mine_inline_scripts(dom_html)
                if inline_harvest and ESTATELY_DEBUG:
                    print(f"[estately] harvested from INLINE: {len(inline_harvest)}")
                if inline_harvest:
                    for d in inline_harvest:
                        if not _passes_min(d.get("price"), min_price):
                            continue
                        if not _passes_min(d.get("beds"), min_beds):
                            continue
                        if not _passes_min(d.get("sqft"), min_sqft):
                            continue
                        _st_txt, _is_active = _extract_status(d)
                        if not _is_active:
                            continue
                        if "agentName" not in d and "agent" in d:
                            d["agentName"] = d.get("agent")
                        if "agentPhone" not in d and "agent_phone" in d:
                            d["agentPhone"] = d.get("agent_phone")
                        key = (d.get("address") or "", d.get("price") or 0)
                        if key in seen:
                            continue
                        seen.add(key)
                        results.append(PropertyCard(
                            address=d.get("address") or "",
                            city=d.get("city"),
                            state=d.get("state"),
                            zip=d.get("zip"),
                            listing_price=d.get("price"),
                            beds=d.get("beds"),
                            baths=d.get("baths"),
                            sqft=d.get("sqft"),
                            source_url=(d.get("href") or url),
                        ))
                        doc = _normalize_property_from_dict(d, d.get("href") or url)
                        mongo_docs.append(doc)

                # Also try a DOM-based parse on the HTTP-fetched HTML
                try:
                    soup_http = BeautifulSoup(dom_html, "lxml")
                    sel_list = [
                        ".js-map-listing-result",
                        "div[data-testid*='MapResultsCard']",
                        "div[class*='PropertyCard__wrapper']",
                        "article[data-testid*='resultCard']",
                        "a[href*='/home/']",
                        "div[data-testid*='MapResults'] .js-map-listing-result",
                        "div[id*='listings'] .js-map-listing-result",
                        "[data-testid='listing-card']",
                        "[data-qa='home-card']",
                        "article.listingCard__wrapper",
                        "article[class*='ListingCard']",
                        "div[class*='PropertyCard']",
                        "section[class*='HomeCard']",
                        "li[class*='result'] article",
                        "a[href*='/listings/']",
                        "article",
                    ]
                    cards_http = soup_http.select(", ".join(sel_list)) or []
                    if ESTATELY_DEBUG:
                        print(f"[estately] HTTP fallback DOM cards: {len(cards_http)}")
                    seen_fallback = set()
                    for c in cards_http:
                        try:
                            data = parse_card(c)
                        except Exception:
                            continue

                        # --- Normalize/enrich before gating by address ---
                        if data.get("href"):
                            data["href"] = make_absolute(url, data["href"])
                        if not _has_min_address(data) and data.get("href"):
                            try:
                                detail_data = await _harvest_from_detail(data["href"], min_price, min_beds, min_sqft)
                                if detail_data:
                                    data.update(detail_data)
                            except Exception:
                                if ESTATELY_DEBUG:
                                    print("[estately] detail harvest failed")

                        if (data.get("price") or 0) < min_price:
                            continue
                        if (data.get("beds") or 0) < min_beds:
                            continue
                        if (data.get("sqft") or 0) < min_sqft:
                            continue

                        card_text = c.get_text(" ", strip=True)
                        if require_no_hoa and not has_no_hoa(card_text):
                            continue
                        if require_distressed and not looks_distressed(card_text):
                            continue

                        _st_txt, _is_active = _extract_status(data, card_text)
                        if not _is_active:
                            continue

                        key = (data.get("address") or "", data.get("price") or 0)
                        if key in seen_fallback:
                            continue
                        seen_fallback.add(key)

                        # Attach card text for contact mining
                        data["_card_text"] = card_text

                        results.append(PropertyCard(
                            address=data.get("address") or "",
                            city=data.get("city"),
                            state=data.get("state"),
                            zip=data.get("zip"),
                            listing_price=data.get("price"),
                            beds=data.get("beds"),
                            baths=data.get("baths"),
                            sqft=data.get("sqft"),
                            source_url=(data.get("href") or url),
                        ))

                        doc = _normalize_property_from_dict(data, data.get("href") or url)
                        doc.setdefault("agentName", doc.get("agent")); doc.setdefault("agentPhone", doc.get("agent_phone"))
                        mongo_docs.append(doc)
                except Exception as dom_fb_err:
                    if ESTATELY_DEBUG:
                        print(f"[estately] HTTP fallback DOM parse failed: {dom_fb_err}")

            if soup is None:
                html = await page.content()
                if ESTATELY_DEBUG:
                    try:
                        h = abs(hash(f"{url}|{len(html)}"))
                        fname = f"/tmp/estately_dom_{h}.html"
                        with open(fname, "w", encoding="utf-8", errors="ignore") as f:
                            f.write(html)
                        print(f"[estately] saved DOM → {fname} :: {url}")
                    except Exception:
                        pass
                soup = BeautifulSoup(html, "lxml")
                cards = soup.select(", ".join([
                    ".js-map-listing-result",
                    "div[data-testid*='MapResultsCard']",
                    "div[class*='PropertyCard__wrapper']",
                    "article[data-testid*='resultCard']",
                    "a[href*='/home/']",
                    "div[data-testid*='MapResults'] .js-map-listing-result",
                    "div[id*='listings'] .js-map-listing-result",
                    "[data-testid='listing-card']",
                    "[data-qa='home-card']",
                    "article.listingCard__wrapper",
                    "article[class*='ListingCard']",
                    "div[class*='PropertyCard']",
                    "section[class*='HomeCard']",
                    "li[class*='result'] article",
                    "a[href*='/listings/']",
                    "article",
                ])) or []

            for c in cards:
                data = parse_card(c)

                if ESTATELY_DEBUG:
                    try:
                        _ct = c.get_text(" ", strip=True)
                        print("[estately] DOM card text:", _ct[:120])
                    except Exception:
                        pass

                if (data.get("price") or 0) < min_price:
                    continue
                if (data.get("beds") or 0) < min_beds:
                    continue
                if (data.get("sqft") or 0) < min_sqft:
                    continue

                card_text = c.get_text(" ", strip=True)
                if require_no_hoa and not has_no_hoa(card_text):
                    continue
                if require_distressed and not looks_distressed(card_text):
                    continue

                _st_txt, _is_active = _extract_status(data, card_text)
                if not _is_active:
                    continue

                key = (data.get("address") or "", data.get("price") or 0)
                if key in seen:
                    continue
                seen.add(key)

                # Attach card text for contact mining
                data["_card_text"] = card_text

                results.append(PropertyCard(
                    address=data.get("address") or "",
                    city=data.get("city"),
                    state=data.get("state"),
                    zip=data.get("zip"),
                    listing_price=data.get("price"),
                    beds=data.get("beds"),
                    baths=data.get("baths"),
                    sqft=data.get("sqft"),
                    source_url=(data.get("href") or url),
                ))

                # Build Mongo doc
                doc = _normalize_property_from_dict(data, data.get("href") or url)
                # duplicate common agent keys for Node schemas (non-breaking)
                doc.setdefault("agentName", doc.get("agent")); doc.setdefault("agentPhone", doc.get("agent_phone"))
                mongo_docs.append(doc)

                # continue to next card
                continue

            # Try to advance via rel=next in the rendered DOM; fall back to soup link
            next_href = None
            try:
                next_href = await page.get_attribute('a[rel="next"], a[aria-label="Next"]', 'href')
            except Exception:
                pass
            if not next_href:
                next_a = soup.select_one('a[rel="next"], a[aria-label="Next"]')
                if next_a and next_a.get("href"):
                    next_href = next_a["href"]

            if not next_href:
                break
            if next_href.startswith("/"):
                next_href = "https://www.estately.com" + next_href
            url = next_href

        # --- Fallback: ensure harvested JSON/inline results are persisted if DOM produced nothing ---
        if not results and (net_bucket or mongo_docs):
            harvested = []
            for blob in net_bucket[-40:]:
                url_b = blob.get("url") or ""
                txt_b = blob.get("text") or ""
                h1 = _extract_estately_map_properties(url_b, txt_b)
                if h1:
                    harvested.extend(h1)
                    continue
                harvested.extend(_extract_listings_from_json_blob(txt_b))
            if harvested and ESTATELY_DEBUG:
                print(f"[estately] FINAL fallback harvest from NET: {len(harvested)}")
            for d in harvested:
                if not _passes_min(d.get("price"), min_price):
                    continue
                if not _passes_min(d.get("beds"), min_beds):
                    continue
                if not _passes_min(d.get("sqft"), min_sqft):
                    continue
                _st_txt, _is_active = _extract_status(d)
                if not _is_active:
                    continue
                key = (d.get("address") or "", d.get("price") or 0)
                if key in seen:
                    continue
                seen.add(key)
                results.append(PropertyCard(
                    address=d.get("address") or "",
                    city=d.get("city"),
                    state=d.get("state"),
                    zip=d.get("zip"),
                    listing_price=d.get("price"),
                    beds=d.get("beds"),
                    baths=d.get("baths"),
                    sqft=d.get("sqft"),
                    source_url=(d.get("href") or url),
                ))
                doc = _normalize_property_from_dict(d, d.get("href") or url)
                doc.setdefault("agentName", doc.get("agent"))
                doc.setdefault("agentPhone", doc.get("agent_phone"))
                mongo_docs.append(doc)

        # --- Persist to MongoDB (upsert by normalized address) ---
        if (_properties_col is not None) and mongo_docs:
            try:
                ops = [
                    UpdateOne(
                        {"fullAddress_ci": d["fullAddress_ci"]},
                        {"$set": d},
                        upsert=True,
                    )
                    for d in mongo_docs
                    if d.get("fullAddress_ci")
                ]
                if ops:
                    res = _properties_col.bulk_write(ops, ordered=False)
                    log.info(
                        "DB UPSERT BULK | ops=%d upserted=%d modified=%d matched=%d",
                        len(ops),
                        getattr(res, "upserted_count", 0),
                        getattr(res, "modified_count", 0),
                        getattr(res, "matched_count", 0),
                    )
                    if ESTATELY_DEBUG:
                        print(f"[estately] upserted {len(ops)} docs into MongoDB")
            except Exception as e:
                print(f"[estately] Mongo upsert failed: {e}")

        if ESTATELY_DEBUG:
            print(f"[estately] FINAL persist summary: results={len(results)} mongo_docs={len(mongo_docs)}")
        return results
    finally:
        try:
            await browser.close()
        finally:
            # Stop the Playwright driver if we created it via fallback
            _p = getattr(browser, "_playwright", None)
            if _p is not None:
                await _p.stop()