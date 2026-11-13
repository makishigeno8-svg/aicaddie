"""日本のゴルフ場一覧（OpenStreetMap）を都道府県ごとに取得して data/courses-jp.json を作る。
GitHub Actions から実行（毎月1回）。データ: © OpenStreetMap contributors (ODbL)"""
import json, time, datetime, math, sys, urllib.request, urllib.parse
try:
    import pykakasi
    _kks = pykakasi.kakasi()
    def reading(s):
        return "".join(i["hira"] for i in _kks.convert(s))
except Exception:
    def reading(s):
        return ""

PREFS = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
         "新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県",
         "奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県",
         "熊本県","大分県","宮崎県","鹿児島県","沖縄県"]
EPS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
       "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
UA = "aicaddie-course-list/1.0 (personal golf app; github.com/makishigeno8-svg/aicaddie)"

def overpass(query):
    last = None
    for attempt in range(4):
        for ep in EPS:
            try:
                req = urllib.request.Request(ep, data=urllib.parse.urlencode({"data": query}).encode(), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.load(r)
            except Exception as e:
                last = e
                print("  retry:", ep, e, flush=True)
                time.sleep(15)
    raise RuntimeError(last)

def size_m(b):
    dy = (b["maxlat"] - b["minlat"]) * 111195
    dx = (b["maxlon"] - b["minlon"]) * 111195 * math.cos(math.radians((b["maxlat"] + b["minlat"]) / 2))
    return math.hypot(dx, dy)

out = {}
for i, pref in enumerate(PREFS, 1):
    code = f"JP-{i:02d}"
    q = f'[out:json][timeout:200];area["ISO3166-2"="{code}"]->.a;(way["leisure"="golf_course"](area.a);relation["leisure"="golf_course"](area.a););out tags center bb;'
    j = overpass(q)
    n = 0
    for e in j.get("elements", []):
        t = e.get("tags", {})
        name = t.get("name:ja") or t.get("name")
        c, b = e.get("center"), e.get("bounds")
        if not name or not c or not b:
            continue
        if t.get("golf") in ("driving_range", "miniature") or "練習場" in name or "ミニゴルフ" in name or "パターゴルフ" in name:
            continue
        if size_m(b) < 250:  # 小さすぎるもの（練習場など）は除外
            continue
        key = f"{e['type'][0]}{e['id']}"
        if key in out:
            continue
        kana = t.get("name:ja-Hira") or t.get("name:ja-Kana") or t.get("name:ja_kana") or ""
        auto = reading(name)
        if auto and auto != kana:
            kana = (kana + " " + auto).strip()
        out[key] = [name, kana, pref, round(c["lat"], 5), round(c["lon"], 5),
                    round(b["minlat"], 5), round(b["minlon"], 5), round(b["maxlat"], 5), round(b["maxlon"], 5)]
        n += 1
    print(f"{code} {pref}: {n}", flush=True)
    time.sleep(4)

courses = sorted(out.values(), key=lambda x: (PREFS.index(x[2]), x[0]))
if len(courses) < 500:
    sys.exit(f"取得件数が少なすぎます（{len(courses)}件）。更新を中止します")
data = {"updated": datetime.date.today().isoformat(), "source": "© OpenStreetMap contributors (ODbL)",
        "fields": ["name", "kana", "pref", "lat", "lon", "minlat", "minlon", "maxlat", "maxlon"], "courses": courses}
with open("data/courses-jp.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
print("total:", len(courses))
