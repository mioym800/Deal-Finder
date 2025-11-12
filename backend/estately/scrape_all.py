import os
import csv
import time
import subprocess
from typing import Iterable, List, Tuple, Optional

# =====================
# CONFIG (tweak as needed)
# =====================
# Optional CSV of US cities. Expected headers (case-insensitive):
#   city,state_id[,state_name,population]
# Example row: Phoenix,AZ,Arizona,1626078
CITIES_CSV = os.getenv("SCRAPE_CITIES_CSV", "backend/data/us_cities.csv")

# Minimum population to include a city (set to 0 to include *all* rows)
MIN_POPULATION = int(os.getenv("SCRAPE_MIN_POPULATION", "20000"))

# Scraper params
MIN_PRICE = int(os.getenv("SCRAPE_MIN_PRICE", "200000"))
MAX_PAGES = int(os.getenv("SCRAPE_MAX_PAGES", "2"))
DELAY_BETWEEN_JOBS_SEC = float(os.getenv("SCRAPE_DELAY_SEC", "3"))

# Optional whitelist to limit to certain states (comma-separated, e.g. "AZ,CA,TX").
STATES_WHITELIST = os.getenv("SCRAPE_STATES")

# Hard fallback list if CSV is missing; keeps your old behavior.
FALLBACK_LOCATIONS: List[Tuple[str, str]] = [
    ("Phoenix", "AZ"),
    ("Tucson", "AZ"),
    ("Los Angeles", "CA"),
    ("San Diego", "CA"),
    ("Denver", "CO"),
]

# All 50 state abbreviations for validation
US_STATE_ABBRS = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
    "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
    "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
}


def _normalize_header(h: str) -> str:
    return h.strip().lower().replace(" ", "_")


def load_locations_from_csv(
    path: str,
    states_whitelist: Optional[Iterable[str]] = None,
    min_population: int = 0,
) -> List[Tuple[str, str]]:
    """
    Load (city, state_id) from a CSV. Filters by population (if column exists)
    and optional state whitelist.
    """
    if not os.path.exists(path):
        return []

    wl = None
    if states_whitelist:
        wl = {s.strip().upper() for s in ",".join(states_whitelist).split(",") if s.strip()}

    results: List[Tuple[str, str]] = []

    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        # Normalize fieldnames to be robust to header spelling
        field_map = { _normalize_header(k): k for k in reader.fieldnames or [] }
        city_key = field_map.get("city")
        state_key = field_map.get("state_id") or field_map.get("state")
        pop_key = field_map.get("population")

        if not city_key or not state_key:
            raise RuntimeError(
                "CSV must include headers 'city' and 'state_id' (or 'state')."
            )

        for row in reader:
            city = (row.get(city_key) or "").strip()
            state = (row.get(state_key) or "").strip().upper()
            if not city or state not in US_STATE_ABBRS:
                continue

            if wl and state not in wl:
                continue

            if pop_key is not None:
                try:
                    pop_val = int(str(row.get(pop_key) or "0").replace(",", ""))
                except ValueError:
                    pop_val = 0
                if pop_val < min_population:
                    continue

            results.append((city, state))

    # Deduplicate while preserving order
    seen = set()
    deduped: List[Tuple[str, str]] = []
    for pair in results:
        if pair not in seen:
            seen.add(pair)
            deduped.append(pair)

    return deduped


def iter_locations() -> List[Tuple[str, str]]:
    """Return the list of (city, state) to scrape.

    Prefers the CSV if present; otherwise falls back to a small seed list.
    """
    # 1) Try CSV with 50 states / all cities
    locs = load_locations_from_csv(
        CITIES_CSV,
        states_whitelist=STATES_WHITELIST,
        min_population=MIN_POPULATION,
    )
    # If we successfully loaded, log how many and from where
    if locs:
        print(f"\U0001F4C4 Loaded {len(locs)} locations from {CITIES_CSV} (min_pop={MIN_POPULATION})")
        return locs

    # 2) Fallback
    print(
        f"⚠️  {CITIES_CSV} not found or empty. Using fallback cities only. "
        "To scrape ALL 50 states and cities, provide a CSV with headers: city,state_id[,population] "
        "and set the SCRAPE_CITIES_CSV environment variable to its path."
    )
    return FALLBACK_LOCATIONS


def run_estately_scraper(city: str, state: str) -> None:
    location = f"{city}, {state}"
    cmd = [
        "python",
        "-m",
        "backend.estately.run_scraper",
        location,
        "--pages",
        str(MAX_PAGES),
        "--min-price",
        str(MIN_PRICE),
    ]
    print(f"🚀 Scraping {location} ...")
    subprocess.run(cmd)
    print(f"✅ Done: {location}")


def main() -> None:
    locations = iter_locations()
    total = len(locations)
    print(f"🧭 Planned jobs: {total} locations")

    for idx, (city, state) in enumerate(locations, start=1):
        try:
            print(f"\n[{idx}/{total}] {city}, {state}")
            run_estately_scraper(city, state)
        except Exception as e:
            print(f"⚠️ Error scraping {city}, {state}: {e}")
        finally:
            time.sleep(DELAY_BETWEEN_JOBS_SEC)


if __name__ == "__main__":
    main()