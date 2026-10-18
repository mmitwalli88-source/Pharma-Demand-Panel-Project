# -*- coding: utf-8 -*-
"""
Live Decision Dashboard - watcher script.

Watches Team_2_Enterprise_Dataset_v1.csv and rewrites live_data.json whenever the
file changes. Every dashboard page polls live_data.json once per second, so an
edit to the source appears on screen in well under a second.

Zero external dependencies - Python standard library only (csv, json).
The JSON shape build_snapshot() returns is the contract the pages read; change the
reader or the writer, change both.

Run (both from this folder):
    python watcher.py
    python -m http.server 8000
Then open http://localhost:8000/index.html

Live Refresh Verification (checkpoint D3): with both running, open the CSV,
change a value in actual_demand_units (keep fulfilled + lost equal to it, or
watch the Data quality page flag the broken identity), save, and watch the
dashboard update. Target is under 1 second.

Two kinds of number live in the feed (Playbook 13.4):
  * live figures, recomputed from the CSV on every change;
  * study constants, read from 02_Analysis/results.json and stamped with the row
    count and demand total they were measured on, so a page can warn when the
    source has moved away from the file the study ran on.
"""

import csv
import json
import os
import time
import datetime
import collections
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ============ CONFIG - the only place the dataset is named ============
SOURCE_FILE = HERE.parent / "01_Data" / "Team_2_Enterprise_Dataset_v1.csv"
STUDY_FILE = HERE.parent / "02_Analysis" / "results.json"
STAGE1_FILE = HERE.parent / "02_Analysis" / "stage1_3.json"
OUTPUT_FILE = HERE / "live_data.json"
POLL_SECONDS = 0.2   # file check; the pages poll the JSON every 0.5s, so on-screen latency stays under 1s

DATE_COL = "period_month"
PRODUCT_COL, REGION_COL = "product_id", "region_name"
CHANNEL_COL = "sales_channel"
PROMO_COL = "promotion_status"
# =======================================================================

# row-level feed layout; the shared runtime (app.js) mirrors these positions
FIELDS = ["month", "product", "region", "channel", "promo", "demand", "fulfilled",
          "lost", "forecast", "stockout", "revenue", "gross_profit", "lost_revenue",
          "holding", "expiry", "closing_units", "closing_value"]

REQUIRED = [DATE_COL, PRODUCT_COL, REGION_COL, CHANNEL_COL, PROMO_COL, "product_category",
            "criticality_class", "temperature_class", "days_in_month", "actual_demand_units",
            "fulfilled_units", "lost_sales_units", "baseline_forecast_units", "stockout_flag",
            "sales_revenue_egp", "gross_profit_egp", "lost_revenue_egp", "holding_cost_egp",
            "expiry_cost_egp", "closing_inventory_units", "inventory_carrying_value_egp",
            "opening_inventory_units", "received_units", "expired_units",
            "cost_of_goods_sold_egp", "net_inventory_contribution_egp"]


def load_rows(path):
    with path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError("source has no rows (file mid-save?)")
    missing = [c for c in REQUIRED if c not in rows[0]]
    if missing:   # fail loudly on a changed schema rather than showing zeros
        raise ValueError("source is missing required columns: " + ", ".join(missing))
    return rows


def load_study():
    try:
        s = json.loads(STUDY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    try:   # Stage 1 checklist from analyze.py, shown on the Data quality page
        s["stage1"] = json.loads(STAGE1_FILE.read_text(encoding="utf-8")).get("checks", [])
    except Exception:
        s["stage1"] = []
    return s


def _acc():
    return {"n": 0, "demand": 0, "fulfilled": 0, "lost": 0, "forecast": 0, "abs_err": 0,
            "err": 0, "stockouts": 0, "revenue": 0.0, "gp": 0.0, "lost_rev": 0.0,
            "holding": 0.0, "expiry": 0.0}


def _add(a, d):
    a["n"] += 1
    a["demand"] += d["demand"]
    a["fulfilled"] += d["fulfilled"]
    a["lost"] += d["lost"]
    a["forecast"] += d["forecast"]
    a["abs_err"] += abs(d["forecast"] - d["demand"])
    a["err"] += d["forecast"] - d["demand"]
    a["stockouts"] += d["stockout"]
    a["revenue"] += d["revenue"]
    a["gp"] += d["gp"]
    a["lost_rev"] += d["lost_rev"]
    a["holding"] += d["holding"]
    a["expiry"] += d["expiry"]


def _merge(a, b):
    for k in a:
        a[k] += b[k]


def _out(name, a, total_demand=None):
    """Every ratio is a sum over a sum (Playbook 20.4)."""
    dm = a["demand"]
    o = {
        "name": name, "rows": a["n"], "demand": a["demand"], "fulfilled": a["fulfilled"],
        "lost": a["lost"], "stockouts": a["stockouts"],
        "fill_rate": round(a["fulfilled"] / dm, 6) if dm else 0,
        "stockout_share": round(a["stockouts"] / a["n"], 6) if a["n"] else 0,
        "wape": round(a["abs_err"] / dm, 6) if dm else 0,
        "bias": round(a["err"] / dm, 6) if dm else 0,
        "revenue": int(round(a["revenue"])), "gross_profit": int(round(a["gp"])),
        "margin": round(a["gp"] / a["revenue"], 6) if a["revenue"] else 0,
        "lost_revenue": int(round(a["lost_rev"])),
        "holding": int(round(a["holding"])), "expiry": int(round(a["expiry"])),
    }
    if total_demand:
        o["demand_share"] = round(a["demand"] / total_demand, 6)
    return o


def build_snapshot(rows, mtime=None):
    num = lambda r, c: float(r[c])
    months = sorted({r[DATE_COL] for r in rows})
    mi = {m: i for i, m in enumerate(months)}
    month_days = {}
    for r in rows:
        month_days[r[DATE_COL]] = int(float(r["days_in_month"]))

    prod_meta = {}
    for r in rows:
        p = r[PRODUCT_COL]
        if p not in prod_meta:
            prod_meta[p] = {"id": p, "family": r["product_category"], "form": r.get("dosage_form", ""),
                            "criticality": r["criticality_class"], "storage": r["temperature_class"],
                            "supplier": r.get("supplier_name", "")}
    products = sorted(prod_meta)
    pix = {p: i for i, p in enumerate(products)}
    regions = sorted({r[REGION_COL] for r in rows},
                     key=lambda n: next(r["region_id"] for r in rows if r[REGION_COL] == n))
    rix = {n: i for i, n in enumerate(regions)}
    channels = sorted({r[CHANNEL_COL] for r in rows})
    cix = {n: i for i, n in enumerate(channels)}
    promos = ["No promotion", "Planned"]
    families = sorted({m["family"] for m in prod_meta.values()})
    crits = ["High", "Medium", "Standard"]

    tot = _acc()
    by = {k: collections.defaultdict(_acc) for k in
          ("month", "region", "family", "channel", "promo", "crit", "storage", "product", "series")}
    matrix = collections.defaultdict(_acc)
    series_channel = {}
    raw_rows = []
    viol = collections.Counter()
    last_month = months[-1]
    snap = {"units": 0, "value": 0.0, "demand": 0, "rows": 0}

    for r in rows:
        d = {
            "demand": int(num(r, "actual_demand_units")), "fulfilled": int(num(r, "fulfilled_units")),
            "lost": int(num(r, "lost_sales_units")), "forecast": int(num(r, "baseline_forecast_units")),
            "stockout": int(num(r, "stockout_flag")), "revenue": num(r, "sales_revenue_egp"),
            "gp": num(r, "gross_profit_egp"), "lost_rev": num(r, "lost_revenue_egp"),
            "holding": num(r, "holding_cost_egp"), "expiry": num(r, "expiry_cost_egp"),
        }
        close_u = int(num(r, "closing_inventory_units"))
        close_v = num(r, "inventory_carrying_value_egp")
        m, p, reg = r[DATE_COL], r[PRODUCT_COL], r[REGION_COL]
        fam, crit, stor = r["product_category"], r["criticality_class"], r["temperature_class"]
        ch = r[CHANNEL_COL]
        promo = 1 if r[PROMO_COL] == "Planned" else 0

        # three accumulators per row; every other grouping is merged from the
        # 125 series totals afterwards, which keeps a rebuild well under 100 ms
        _add(by["month"][m], d)
        _add(by["promo"][promos[promo]], d)
        _add(by["series"][(p, reg)], d)
        series_channel[(p, reg)] = ch

        # live reconciliation (Playbook 20.2): identities that must hold row by row
        if d["demand"] != d["fulfilled"] + d["lost"]:
            viol["demand = fulfilled + lost"] += 1
        if (int(num(r, "opening_inventory_units")) + int(num(r, "received_units"))
                - int(num(r, "expired_units")) - d["fulfilled"]) != close_u:
            viol["opening + received - expired - fulfilled = closing"] += 1
        if abs(d["gp"] - (d["revenue"] - num(r, "cost_of_goods_sold_egp"))) > 0.05:
            viol["gross profit = revenue - COGS"] += 1
        if abs(num(r, "net_inventory_contribution_egp")
               - (d["gp"] - d["holding"] - d["expiry"])) > 0.05:
            viol["contribution = GP - holding - expiry"] += 1
        if d["stockout"] != (1 if d["lost"] > 0 else 0):
            viol["stockout flag = (lost > 0)"] += 1

        if m == last_month:   # a stock is a snapshot: latest month only (Playbook 20.4)
            snap["units"] += close_u
            snap["value"] += close_v
            snap["demand"] += d["demand"]
            snap["rows"] += 1

        raw_rows.append([mi[m], pix[p], rix[reg], cix[ch], promo, d["demand"], d["fulfilled"],
                         d["lost"], d["forecast"], d["stockout"], int(round(d["revenue"])),
                         int(round(d["gp"])), int(round(d["lost_rev"])), int(round(d["holding"])),
                         int(round(d["expiry"])), close_u, int(round(close_v))])

    for (p, reg), a in by["series"].items():
        meta = prod_meta[p]
        for key, k in (("region", reg), ("family", meta["family"]), ("channel", series_channel[(p, reg)]),
                       ("crit", meta["criticality"]), ("storage", meta["storage"]), ("product", p)):
            _merge(by[key][k], a)
        _merge(matrix[(reg, meta["family"])], a)
        _merge(tot, a)

    D = tot["demand"]
    series = []
    for (p, reg), a in by["series"].items():
        o = _out(p + " · " + reg, a, D)
        o.update({"product": p, "region": reg, "family": prod_meta[p]["family"]})
        series.append(o)
    series.sort(key=lambda x: -x["lost_revenue"])
    total_lost_rev = sum(s["lost_revenue"] for s in series) or 1
    top_k = max(1, round(len(series) * 0.10))

    def ranked(key, order=None):
        out = [_out(k, a, D) for k, a in by[key].items()]
        if order:
            out.sort(key=lambda x: order.index(x["name"]) if x["name"] in order else 99)
        else:
            out.sort(key=lambda x: -x["demand"])
        return out

    k = _out("total", tot, D)
    cover = (snap["units"] / (snap["demand"] / month_days[last_month])) if snap["demand"] else 0

    study = load_study()
    study_block = None
    if study:
        study_block = {
            "rows": study.get("study_rows"), "demand_total": study.get("study_demand_total"),
            "register": study.get("register", []),
            "multiple_comparisons": study.get("multiple_comparisons", {}),
            "model": study.get("model", {}), "stability": study.get("stability", {}),
            "power": study.get("power", {}), "aliases": study.get("aliases", []),
            "promotion": study.get("promotion", {}), "seasonal_index": study.get("seasonal_index", {}),
            "benford": study.get("benford", {}), "stage1": study.get("stage1", []),
            "bootstrap_region_worst_stockout": study.get("bootstrap_region_worst_stockout", {}),
        }

    now = time.time()
    return {
        "snapshot_id": int(now * 1000),
        "last_updated": datetime.datetime.now().astimezone().isoformat(timespec="milliseconds"),
        "source_file": SOURCE_FILE.name,
        "source_mtime_ms": int(mtime * 1000) if mtime else None,
        "row_count": len(rows),
        "raw": {
            "fields": FIELDS, "months": months, "month_days": [month_days[m] for m in months],
            "products": [prod_meta[p] for p in products], "regions": regions,
            "channels": channels, "promos": promos, "families": families, "criticalities": crits,
            "rows": raw_rows,
        },
        "kpis": {
            **k,
            "months": len(months), "first_month": months[0], "last_month": last_month,
            "products": len(products), "regions": len(regions), "series": len(series),
        },
        "snapshot": {"month": last_month, "closing_units": snap["units"],
                     "closing_value": int(round(snap["value"])), "cover_days": round(cover, 2)},
        "trend": [dict(_out(m, by["month"][m], D), month=m, forecast=by["month"][m]["forecast"])
                  for m in months],
        "by_region": ranked("region"),
        "by_family": ranked("family"),
        "by_channel": ranked("channel"),
        "by_promo": ranked("promo", promos),
        "by_criticality": ranked("crit", crits),
        "by_storage": ranked("storage"),
        "by_product": ranked("product"),
        "top_series": series[:top_k],
        "concentration": {
            "series": len(series), "top_k": top_k,
            "top_series_lost_revenue_share": round(sum(s["lost_revenue"] for s in series[:top_k]) / total_lost_rev, 4),
            "series_without_stockout": sum(1 for s in series if s["stockouts"] == 0),
            "top5_product_demand_share": round(sum(p["demand"] for p in ranked("product")[:5]) / D, 4) if D else 0,
        },
        "matrix": {
            "regions": regions, "families": families,
            "stockout_share": [[_out("", matrix[(r_, f_)])["stockout_share"] if (r_, f_) in matrix else None
                                for f_ in families] for r_ in regions],
            "wape": [[_out("", matrix[(r_, f_)])["wape"] if (r_, f_) in matrix else None
                      for f_ in families] for r_ in regions],
            "lost_revenue": [[_out("", matrix[(r_, f_)])["lost_revenue"] if (r_, f_) in matrix else None
                              for f_ in families] for r_ in regions],
        },
        "reconciliation": {
            "checked_rows": len(rows),
            "violations": {n: viol.get(n, 0) for n in (
                "demand = fulfilled + lost", "opening + received - expired - fulfilled = closing",
                "gross profit = revenue - COGS", "contribution = GP - holding - expiry",
                "stockout flag = (lost > 0)")},
        },
        "study": study_block,
    }


def write_atomic(snap):
    tmp = OUTPUT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(snap, separators=(",", ":")), encoding="utf-8")
    for _ in range(5):          # the web server may hold the target for a moment
        try:
            os.replace(tmp, OUTPUT_FILE)
            return
        except PermissionError:
            time.sleep(0.02)
    OUTPUT_FILE.write_text(tmp.read_text(encoding="utf-8"), encoding="utf-8")


def main():
    print(f"Watching {SOURCE_FILE.name} -> writing {OUTPUT_FILE.name}")
    print(f"Polling every {POLL_SECONDS}s. Ctrl+C to stop.")
    last = None
    while True:
        try:
            mtime = SOURCE_FILE.stat().st_mtime
            if mtime != last:
                t0 = time.time()
                snap = build_snapshot(load_rows(SOURCE_FILE), mtime)
                snap["latency_ms"] = int(round((time.time() - mtime) * 1000))
                write_atomic(snap)
                last = mtime
                print(f"[{snap['last_updated']}] source changed -> {OUTPUT_FILE.name} rewritten "
                      f"({snap['row_count']} rows, {snap['kpis']['demand']:,} packs, "
                      f"save-to-snapshot {snap['latency_ms']} ms, build {int((time.time()-t0)*1000)} ms)", flush=True)
        except FileNotFoundError:
            print(f"Waiting for {SOURCE_FILE.name} to exist...")
        except Exception as exc:  # noqa: BLE001 - keep polling through a mid-save read
            print(f"Skipped a snapshot (source mid-write or malformed): {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()


