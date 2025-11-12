# backend/estately/parsing.py
from bs4 import BeautifulSoup, Tag
import re
from urllib.parse import urljoin
import json

__all__ = ["parse_card", "select_cards", "should_keep"]

# --- number helpers ---------------------------------------------------------
# Match numbers like: 1,234  •  1,234.5  •  3–4 (take first)  •  3 to 4 (take first)
_num_any = re.compile(r"(\d{1,3}(?:[,\d]{0,3})*(?:\.\d+)?)")
_sqft_tokens = re.compile(r"\b(?:sq\.?\s*ft|square\s*feet|sf)\b", re.I)
_bed_tokens = re.compile(r"\bbed(?:rooms?)?\b", re.I)
_bath_tokens = re.compile(r"\bbath(?:rooms?)?\b", re.I)


def _first_number(s: str | None):
    if not s:
        return None
    m = _num_any.search(s)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except Exception:
        return None


# --- tiny utils -------------------------------------------------------------

def _text(el):
    if not el:
        return None
    try:
        return el.get_text(" ", strip=True)
    except Exception:
        return None


def _pick(soup, selectors: list[str]):
    for sel in selectors:
        el = soup.select_one(sel)
        if el:
            return el
    return None


def _jsonld_from_card(card) -> dict | None:
    """
    Pull a single JSON-LD object from within the card, if present.
    Estately cards often embed a list with objects like:
      - @type: SingleFamilyResidence (has address, floorSize, rooms, baths)
      - @type: Product / Offer (has price info)
    We return a merged-ish view prioritizing the residence object, then product/offer.
    """
    try:
        script = card.select_one("script[type='application/ld+json']")
        if not script:
            return None
        raw = script.string or script.get_text(strip=True)
        if not raw:
            return None
        data = json.loads(raw)
        # Normalize to list
        items = data if isinstance(data, list) else [data]
        # Prefer a residence-like object
        def _is_residence(obj):
            return str(obj.get("@type", "")).lower() in {
                "singlefamilyresidence", "house", "apartment", "residence"
            }
        residence = next((o for o in items if isinstance(o, dict) and _is_residence(o)), None)
        # Then prefer product/offer for price
        def _is_product(obj):
            return str(obj.get("@type", "")).lower() in {"product"}
        product = next((o for o in items if isinstance(o, dict) and _is_product(o)), None)
        offer = None
        # Offer might be embedded in product or residence
        for host in (product, residence) if product or residence else items:
            if isinstance(host, dict):
                off = host.get("offers")
                if isinstance(off, list) and off:
                    offer = off[0]
                    break
                if isinstance(off, dict):
                    offer = off
                    break
        # Compose a light merged dict for convenience
        merged = {}
        if residence:
            merged.update(residence)
        if product:
            # keep existing keys; only set if absent
            for k, v in product.items():
                merged.setdefault(k, v)
        if offer:
            merged.setdefault("offers", offer)
        return merged or None
    except Exception:
        return None

def _qv_value(x):
    """Return numeric value from a QuantitativeValue-ish dict or raw."""
    if isinstance(x, dict):
        # prefer explicit 'value'; some sites use 'value' as string
        v = x.get("value")
        try:
            return float(str(v).replace(",", "")) if v is not None else None
        except Exception:
            return None
    # raw number/text
    try:
        return float(str(x).replace(",", "")) if x is not None else None
    except Exception:
        return None

# --- estately / extension sanitation & href helpers ------------------------

def _strip_extension_ui(root):
    """Remove nodes injected by browser extensions (e.g., Jobright/Plasmo) that
    can pollute anchors/text. Safe no-op if not present."""
    try:
        for node in root.select(
            "plasmo-csui, #jobright-helper-plugin, [id^='jobright-helper']"
        ):
            node.decompose()
    except Exception:
        pass
    return root


def _in_extension_ui(el: Tag) -> bool:
    """Return True if the element is inside a known extension container."""
    try:
        for p in [el] + list(el.parents):
            if not isinstance(p, Tag):
                continue
            if p.name in ("plasmo-csui",):
                return True
            pid = (p.get("id") or "").lower()
            cls = " ".join(p.get("class", [])).lower()
            if pid.startswith("jobright-helper") or "jobright-helper" in cls:
                return True
        return False
    except Exception:
        return False


def _first_price(s: str | None):
    """Parse the first number in a string with optional k/m/b suffix into an absolute value."""
    if not s:
        return None
    try:
        m = re.search(r"(\d{1,3}(?:[,\d]{0,3})*(?:\.\d+)?)(?:\s*([kKmMbB]))?", s)
        if not m:
            return None
        val = float(m.group(1).replace(",", ""))
        suf = (m.group(2) or "").lower()
        if suf == "k":
            val *= 1_000
        elif suf == "m":
            val *= 1_000_000
        elif suf == "b":
            val *= 1_000_000_000
        return val
    except Exception:
        return None


def _first_valid_anchor(card) -> str | None:
    # Prefer anchors that are not inside extension UI
    for a in card.select("a[href]"):
        try:
            href = a.get("href")
            if not href:
                continue
            if _in_extension_ui(a):
                continue
            if any(p in href for p in ("/listings/", "/home/", "/homes/", "/property/")):
                return urljoin("https://www.estately.com/", href)
        except Exception:
            continue
    # fallback to any non-extension anchor
    for a in card.select("a[href]"):
        href = a.get("href")
        if href and not _in_extension_ui(a):
            return urljoin("https://www.estately.com/", href)
    return None


def _extract_href(card) -> str | None:
    # React Router / data-* fallbacks if no clean anchor exists
    href = _first_valid_anchor(card)
    if href:
        return href

    candidate = None
    for el in card.select("[to], [data-href], [data-url], [data-listing-url], [role='link'], [aria-label]"):
        if _in_extension_ui(el):
            continue
        candidate = el
        break

    if candidate:
        for attr in ("href", "to", "data-href", "data-url", "data-listing-url"):
            v = candidate.get(attr)
            if v:
                return urljoin("https://www.estately.com/", v)

    # script/JSON blob fallback
    for s in card.select("script[type='application/ld+json'], script"):
        if _in_extension_ui(s):
            continue
        try:
            txt = (s.string or s.get_text("", strip=True) or "")
            m = re.search(r'"(?:url|@id)"\s*:\s*"(?P<u>\/[^"]+)"', txt)
            if m:
                return urljoin("https://www.estately.com/", m.group("u"))
        except Exception:
            pass

    # final regex scrape on the card's html
    html = str(card)
    m = re.search(r'href=\"(\/[A-Za-z0-9_\-\/]+)\"', html)
    if m:
        return urljoin("https://www.estately.com/", m.group(1))

    return None

def _is_probable_card(el: Tag) -> bool:
    """Heuristic to confirm an element is a listing card."""
    try:
        if _in_extension_ui(el):
            return False
        # Must contain either a JSON-LD blob or an address-ish node
        if el.select_one("script[type='application/ld+json']"):
            return True
        if el.select_one(
            "[data-testid*='address'],[data-qa*='address'],.ListingCard-address,.listing-address,.result-address"
        ):
            return True
        # Or have a price + link combo
        has_price = bool(
            el.select_one(
                "[data-testid*='price'],.ListingCard-price,.listing-price,[itemprop='price'],meta[itemprop='price'],[class*='price'],.result-price"
            )
        )
        has_link = bool(el.select_one("a[href]"))
        return has_price and has_link
    except Exception:
        return False


def select_cards(root: Tag) -> list[Tag]:
    """
    Return a robust list of full Estately listing card <.js-map-listing-result> nodes.
    Falls back to older skins (.ListingCard, .result, etc.) but avoids fragments like
    photo or address-only divs. Strips extension UI first.
    """
    if not isinstance(root, Tag):
        return []
    _strip_extension_ui(root)

    # Primary Estately skin uses custom elements
    cards = root.select(".js-map-listing-result")
    if not cards:
        # Try older card wrappers
        cards = root.select(
            ".ListingCard, .listing-card, .result, .result-card, .result-list .result, "
            "li[class*='result'], article[class*='card'], [data-testid*='listing-card'], [data-qa*='listing-card']"
        )

    # Deduplicate and keep only probable cards
    seen = set()
    filtered = []
    for el in cards:
        if not isinstance(el, Tag):
            continue
        if _in_extension_ui(el):
            continue
        if not _is_probable_card(el):
            continue
        key = id(el)
        if key in seen:
            continue
        filtered.append(el)
        seen.add(key)

    return filtered


def should_keep(row: dict) -> bool:
    """
    Signal whether a parsed row should be retained by the collector.
    Drops entries that are missing an address or both price+href, and any marked `_weak`.
    """
    if not row:
        return False
    if not row.get("address"):
        return False
    if not (row.get("price") or row.get("href")):
        return False
    if row.get("_weak"):
        return False
    return True

# --- main ------------------------------------------------------------------

def parse_card(card) -> dict:
    """
    Parse an Estately (or similar) listing card bs4 Tag into a normalized dict:
    {address, city, state, zip, price, beds, baths, sqft, href}

    This version is resilient to multiple DOM skins used across markets.
    """
    out: dict = {}

    # Strip intrusive extension DOM to avoid bogus anchors/text
    _strip_extension_ui(card)

    # Address line (street)
    addr_el = _pick(
        card,
        [
            "[data-testid*='address']",
            "[data-qa*='address']",
            ".ListingCard-address",
            ".listing-address",
            "span[itemprop='streetAddress']",
            "[class*='street']",
            ".result-address a",     # Estately results skin
            ".result-address",       # fallback
        ],
    )
    out["address"] = _text(addr_el)

    # Location line (City, ST 85001)
    loc_el = _pick(
        card,
        [
            ".ListingCard-location",
            ".listing-location",
            "[itemprop='addressLocality']",
            "[data-testid*='location']",
            "[class*='cityState']",
            "[class*='location']",
            ".result-address a",  # e.g. "19807 Emerald Bend Way, Houston, TX"
        ],
    )
    city = state = zipc = None
    if loc_el:
        loc_txt = _text(loc_el) or ""
        # Typical: "Phoenix, AZ 85001" or "Phoenix, AZ"
        m = re.match(r"\s*([^,]+)\s*,\s*([A-Za-z]{2})(?:\s+(\d{5}))?", loc_txt)
        if m:
            city, state, zipc = m.group(1), m.group(2), m.group(3)
        else:
            # Some skins split city/state
            c_el = card.select_one("[itemprop='addressLocality']")
            s_el = card.select_one("[itemprop='addressRegion']")
            z_el = card.select_one("[itemprop='postalCode']")
            city = _text(c_el) or city
            state = _text(s_el) or state
            zipc = _text(z_el) or zipc
    out["city"], out["state"], out["zip"] = city, state, zipc

    # Price
    price_el = _pick(
        card,
        [
            "[data-testid*='price']",
            ".ListingCard-price",
            ".listing-price",
            "[itemprop='price']",
            "meta[itemprop='price']",
            "[class*='price']",
            ".result-price strong",  # Estately results skin
            ".result-price",         # fallback
        ],
    )
    price_txt = None
    if price_el:
        # meta tag?
        if getattr(price_el, "name", "").lower() == "meta":
            price_txt = price_el.get("content")
        else:
            price_txt = _text(price_el)
    out["price"] = _first_price(price_txt)

    # Facts (beds/baths/sqft). Search broadly and bias on nearby tokens
    facts_blob = _text(card) or ""
    # Remove photo/image/view tokens to avoid extracting unrelated numbers
    facts_blob = re.sub(r"\b(view|photo|photos|image|images)\b", "", facts_blob, flags=re.I)

    # Beds
    beds = None
    bed_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:beds?|bd|bedroom)", facts_blob, re.I)
    if bed_match:
        beds = float(bed_match.group(1))

    # Baths
    baths = None
    bath_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:baths?|ba|bathroom)", facts_blob, re.I)
    if bath_match:
        baths = float(bath_match.group(1))

    # Sqft
    sqft = None
    sqft_el = card.find(string=_sqft_tokens)
    if not isinstance(sqft_el, str) and sqft_el is not None:
        sqft_el = sqft_el.get_text(" ", strip=True)
    sqft_ctx = str(sqft_el) if sqft_el else facts_blob
    if _sqft_tokens.search(sqft_ctx or ""):
        sqft = _first_number(sqft_ctx)
    else:
        # fallback: any number followed by 'sf' without dot
        m = re.search(r"(\d[\d,\.]+)\s*sf\b", facts_blob, re.I)
        sqft = float(m.group(1).replace(",", "")) if m else None

    out["beds"], out["baths"], out["sqft"] = beds, baths, sqft

    # Link (robust: skip extension-injected anchors, support SPA/data-* patterns)
    href = _extract_href(card)
    out["href"] = href
    
     # ---------- JSON-LD backfill (strong and less brittle) ----------
    ld = _jsonld_from_card(card)
    if ld:
        # Address fields
        addr = ld.get("address") if isinstance(ld.get("address"), dict) else ld.get("address", {})
        street = addr.get("streetAddress")
        city_ld = addr.get("addressLocality")
        state_ld = addr.get("addressRegion")
        zip_ld = addr.get("postalCode")

        if street and (not out.get("address") or street not in out.get("address", "")):
            out["address"] = street
        if city_ld:
            out["city"] = out.get("city") or city_ld
        if state_ld:
            out["state"] = out.get("state") or state_ld
        if zip_ld:
            out["zip"] = out.get("zip") or zip_ld

        # URL
        if not out.get("href"):
            url_ld = ld.get("url")
            if isinstance(url_ld, str):
                out["href"] = urljoin("https://www.estately.com/", url_ld)

        # Numbers
        if out.get("beds") is None:
            out["beds"] = _qv_value(ld.get("numberOfRooms"))
        if out.get("baths") is None:
            out["baths"] = _qv_value(ld.get("numberOfBathroomsTotal"))
        if out.get("sqft") is None:
            fs = ld.get("floorSize")
            out["sqft"] = _qv_value(fs)
            if out["sqft"] is None and isinstance(fs, dict):
                out["sqft"] = _qv_value(fs.get("value"))

        # Price can be in offers or product
        if out.get("price") is None:
            offers = ld.get("offers")
            price_ld = None
            if isinstance(offers, dict):
                price_ld = offers.get("price")
            elif isinstance(offers, list) and offers:
                price_ld = offers[0].get("price")
            if price_ld is None:
                price_ld = ld.get("price")
            out["price"] = _qv_value(price_ld) or out.get("price")

    # Minimal validity: price OR link plus address
    if not out.get("address"):
        return {}
    if not (out.get("price") or out.get("href")):
        # keep but mark as weak; caller can decide whether to drop
        out.setdefault("_weak", True)

    return out
def parse_all_cards(html: str):
    """
    Convenience function for full HTML: parses and filters cards in one shot.
    Returns only strong (should_keep=True) rows.
    """
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    cards = select_cards(soup)
    parsed = [parse_card(c) for c in cards]
    return [r for r in parsed if should_keep(r)]