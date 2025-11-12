from typing import Dict, Tuple
from urllib.parse import urlencode


def _slug(s: str) -> str:
    """Convert a city like 'Paradise Valley' → 'paradise-valley'."""
    return "-".join(s.strip().lower().split())


def parse_market(market: str) -> Tuple[str, str]:
    """
    Parse a market string like 'Phoenix, AZ' or 'Phoenix, Arizona' into:
      - st: 2-letter lowercase state code (e.g., 'az')
      - city: slugified city (e.g., 'phoenix', 'paradise-valley')
    """
    parts = [p.strip() for p in market.split(",")]
    if len(parts) != 2:
        raise ValueError(f"Expected 'City, ST' or 'City, State', got: {market!r}")

    city_raw, state_raw = parts[0], parts[1]
    city = _slug(city_raw)

    # If already a 2-letter code, just normalize. Otherwise, map full name → code.
    sr = state_raw.strip()
    if len(sr) == 2:
        st = sr.lower()
    else:
        # Minimal mapping to keep things lightweight; extend as needed.
        STATE_TO_ABBR = {
            "alabama": "al", "alaska": "ak", "arizona": "az", "arkansas": "ar",
            "california": "ca", "colorado": "co", "connecticut": "ct",
            "delaware": "de", "florida": "fl", "georgia": "ga", "hawaii": "hi",
            "idaho": "id", "illinois": "il", "indiana": "in", "iowa": "ia",
            "kansas": "ks", "kentucky": "ky", "louisiana": "la", "maine": "me",
            "maryland": "md", "massachusetts": "ma", "michigan": "mi",
            "minnesota": "mn", "mississippi": "ms", "missouri": "mo",
            "montana": "mt", "nebraska": "ne", "nevada": "nv", "new hampshire": "nh",
            "new jersey": "nj", "new mexico": "nm", "new york": "ny",
            "north carolina": "nc", "north dakota": "nd", "ohio": "oh",
            "oklahoma": "ok", "oregon": "or", "pennsylvania": "pa",
            "rhode island": "ri", "south carolina": "sc", "south dakota": "sd",
            "tennessee": "tn", "texas": "tx", "utah": "ut", "vermont": "vt",
            "virginia": "va", "washington": "wa", "west virginia": "wv",
            "wisconsin": "wi", "wyoming": "wy",
            "district of columbia": "dc", "washington dc": "dc", "dc": "dc",
        }
        key = sr.lower()
        st = STATE_TO_ABBR.get(key)
        if not st:
            raise ValueError(f"Unrecognized state: {state_raw!r}")

    return st, city


def build_search_url(
    market: str,
    min_price: int = 600000,
    max_price: int | None = None,
    min_beds: int = 3,
    min_sqft: int = 1000,
    no_hoa: bool = True,
    distressed: bool = True,
    property_type: str = "house",
    sort: str = "newest",
    debug: bool = False,
) -> str:
    """
    Build an Estately search URL for a given market (e.g. "Phoenix, AZ").
    Adds optional filters like max_price, property_type, sorting, HOA exclusion, and distressed keywords.
    """
    st, city = parse_market(market)
    base = f"https://www.estately.com/{st}/{city}"
    params: Dict[str, str | int] = {
        "min_price": min_price,
        "min_beds": min_beds,
        "min_sqft": min_sqft,
        "property_type": property_type,
        "status": "active",
        "sort": sort,
    }
    if max_price:
        params["max_price"] = max_price
    if no_hoa:
        params["hoa"] = "no"
    if distressed:
        params["keywords"] = "fixer,foreclosure,short+sale,reo,distressed"

    url = base + "?" + urlencode(params)
    if debug:
        print(f"[filters] build_search_url → {url}")
    return url