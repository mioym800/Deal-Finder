import asyncio
import os
import json
import csv
import logging
from dataclasses import asdict, is_dataclass
from .scraper import collect_estately
import csv
from pathlib import Path

def parse_args():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument(
        "market",
        nargs="?",
        default=None,
        help='City, ST (optional). If omitted, markets are read from --markets-file'
    )
    p.add_argument("--pages", type=int, default=1)
    p.add_argument("--min-price", type=int, default=600000)
    p.add_argument("--min-beds", type=int, default=3)
    p.add_argument("--min-sqft", type=int, default=1000)
    p.add_argument("--distressed", action="store_true")
    p.add_argument("--no-hoa", action="store_true")
    p.add_argument("--output", help="Optional path to save results as .json or .csv")
    p.add_argument("--print-details", action="store_true", help="Print each property row to stdout")
    p.add_argument("--verbose", action="store_true", help="Enable verbose logging for the estately scraper")

    # NEW: CSV-driven market loading
    from pathlib import Path
    p.add_argument(
        "--markets-file",
        default=str(Path(__file__).resolve().parents[1] / "data" / "uscities.csv"),
        help="CSV with cities (columns must include city + 2-letter state; e.g., city,state)"
    )
    p.add_argument("--per-state", type=int, default=2, help="Top-N cities per state by population (if present)")
    p.add_argument("--max-markets", type=int, default=200, help="Total markets cap when auto-loading")
    return p.parse_args()

def _pick_state_abbr(row: dict) -> str | None:
    for k in ("state", "st", "state_id", "state_code", "state_abbr"):
        if k in row and row[k]:
            s = str(row[k]).strip()
            if len(s) == 2:
                return s.upper()
    return None

def _pick_city(row: dict) -> str | None:
    for k in ("city", "city_name", "name"):
        if k in row and row[k]:
            return str(row[k]).strip()
    return None

def _pick_population(row: dict) -> float:
    for k in ("population", "pop", "pop2020", "pop_estimate"):
        v = row.get(k)
        if v not in (None, "", "NA"):
            try:
                return float(str(v).replace(",", ""))
            except Exception:
                pass
    return 0.0

def load_markets_from_csv(csv_path: str | Path, per_state: int | None = None, max_markets: int | None = None) -> list[str]:
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"Markets file not found: {path}")
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = []
        for r in reader:
            city = _pick_city(r)
            st = _pick_state_abbr(r)
            if not city or not st:
                continue
            rows.append({"city": city, "state": st, "pop": _pick_population(r)})

    from collections import defaultdict
    by_state = defaultdict(list)
    for r in rows:
        by_state[r["state"]].append(r)

    markets = []
    for st, items in by_state.items():
        items.sort(key=lambda x: x["pop"], reverse=True)
        take = items[: (per_state or len(items))]
        markets.extend([f'{r["city"]}, {st}' for r in take])

    if max_markets is not None and len(markets) > max_markets:
        markets = markets[:max_markets]
    return markets




async def main():
    args = parse_args()

    if args.verbose:
        logging.getLogger("estately").setLevel(logging.DEBUG)

    # Decide markets
    if args.market:
        markets = [args.market]
    else:
        markets = load_markets_from_csv(args.markets_file, per_state=args.per_state, max_markets=args.max_markets)
        print(f"📍 Auto-loaded {len(markets)} markets from {args.markets_file}")

    import random

    CONCURRENCY = 5  # tweak 3–8 depending on how aggressive you want to be

    async def scrape_one(m):
        print(f"\n🔍 Scraping Estately for {m} ...")
        try:
            # Random stagger to be polite / avoid bursty traffic
            await asyncio.sleep(random.uniform(0.3, 1.3))
            props = await collect_estately(
                market=m,
                max_pages=args.pages,
                min_price=args.min_price,
                min_beds=args.min_beds,
                min_sqft=args.min_sqft,
                require_distressed=args.distressed,
                require_no_hoa=args.no_hoa,
            )
            print(f"✅ {m}: {len(props)} properties collected.")
            return props
        except Exception as e:
            print(f"❌ Error scraping {m}: {e}")
            return []

    sem = asyncio.Semaphore(CONCURRENCY)

    async def bound_scrape(m):
        async with sem:
            return await scrape_one(m)

    results = await asyncio.gather(*(bound_scrape(m) for m in markets))
    all_props = [p for batch in results for p in batch]

    props = all_props  # keep the rest of your print/save logic below exactly as-is

    # (from here down, keep your existing "print-details" and "output" handling)
    if args.print_details:
        for p in props:
            try:
                addr = ", ".join(filter(None, [p.address, f"{p.city or ''}, {p.state or ''} {p.zip or ''}".strip(", ")]))
                price = f"${int(p.listing_price):,}" if getattr(p, "listing_price", None) is not None else "N/A"
                beds = f"{int(p.beds)} bd" if getattr(p, "beds", None) is not None else "--"
                baths = f"{int(p.baths)} ba" if getattr(p, "baths", None) is not None else "--"
                sqft = f"{int(p.sqft):,} sqft" if getattr(p, "sqft", None) is not None else "--"
                print(f"- {addr} | {price} | {beds} / {baths} | {sqft} | {getattr(p, 'source_url', '')}")
            except Exception:
                print(f"- {getattr(p, 'address', '')} | {getattr(p, 'source_url', '')}")

    if args.output:
        out_path = args.output
        rows = []
        for p in props:
            if is_dataclass(p):
                d = asdict(p)
            else:
                d = {
                    "address": getattr(p, "address", None),
                    "city": getattr(p, "city", None),
                    "state": getattr(p, "state", None),
                    "zip": getattr(p, "zip", None),
                    "listing_price": getattr(p, "listing_price", None),
                    "beds": getattr(p, "beds", None),
                    "baths": getattr(p, "baths", None),
                    "sqft": getattr(p, "sqft", None),
                    "source_url": getattr(p, "source_url", None),
                }
            rows.append(d)

        if out_path.lower().endswith(".json"):
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(rows, f, indent=2, ensure_ascii=False, default=str)
            print(f"Saved {len(rows)} properties to {out_path}")
        elif out_path.lower().endswith(".csv"):
            fieldnames = ["address","city","state","zip","listing_price","beds","baths","sqft","source_url"]
            with open(out_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for r in rows:
                    writer.writerow({k: r.get(k) for k in fieldnames})
            print(f"Saved {len(rows)} properties to {out_path}")
        else:
            print(f"[warn] Unknown output format for '{out_path}'. Use .json or .csv")

    print(f"\nCollected {len(props)} PropertyCard(s).")


if __name__ == "__main__":
    asyncio.run(main())