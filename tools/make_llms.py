# -*- coding: utf-8 -*-
"""Write /llms.txt: a plain-text map of the site for AI assistants and answer engines (llmstxt.org).

  python tools/make_llms.py        (re-run after adding a report or a page)

Built from the English pages (titles, meta descriptions) and the Reports hub cards, so it never drifts
from what the site says.
"""
import glob, html, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://www.heirstoneconsulting.com"
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf-8").read()
un = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def meta(page):
    s = rd(f"pages/{page}.html")
    h1 = re.search(r"<h1>(.*?)</h1>", s, re.S)
    d = re.search(r'<meta name="description" content="([^"]*)"', s)
    return un(h1.group(1)) if h1 else page, html.unescape(d.group(1)) if d else ""


home = rd("index.html")
nav = re.search(r'<div class="dropdown-menu">(.*?)</div>', home, re.S).group(1)
practices = re.findall(r'<a href="pages/([\w-]+)">', nav)
pages = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(ROOT, "pages", "*.html")))
company = ["about", "experience", "reports", "insights", "contact"]
articles = [p for p in pages if re.search(r'"@type": "Article"', rd(f"pages/{p}.html"))]
services = [p for p in pages if p not in practices + company + articles + ["services"] and not p.startswith("report-")]

hub = rd("pages/reports.html")
cat = json.load(open(os.path.join(ROOT, "private", "reports", "catalog.json"), encoding="utf-8"))
NAMES = {"en": "English", "fr": "French", "ru": "Russian"}
SERIES = [("africa", "The Africa Series"), ("general", "Middle East and Mediterranean"), ("central-asia", "Central Asia")]
langs = re.findall(r'<a href="/(?:(\w\w)/)?" hreflang="[^"]+" lang="[^"]+" data-lang="\w+"[^>]*>([^<]+)</a>', home)

out = ["# Heirstone Consulting", "",
       "> Strategy advisory for real estate, tourism and national development across the Middle East, Africa and "
       "Central Asia, with offices in Dubai and Cairo. Publishes free research reports on these markets.", "",
       "Heirstone Consulting & Strategic Advisory (Heirstone Consulting L.L.C-FZ, Meydan Grandstand, Dubai) advises "
       "governments, state and institutional investors and developers on market and feasibility studies, real estate "
       "and tourism strategy, national vision programmes, public-private partnerships, asset monetisation and digital "
       "transformation. Contact: info@heirstoneconsulting.com. LinkedIn: https://www.linkedin.com/company/heirstoneconsulting", "",
       "## Practices", ""]
out += [f"- [{t}]({SITE}/pages/{p}): {d}" for p in practices for t, d in [meta(p)]]
out += ["", "## Services", ""]
out += [f"- [{t}]({SITE}/pages/{p}): {d}" for p in services for t, d in [meta(p)]]
out += ["", "## Research reports", "",
        "Free PDFs, sent by email from each report page. Each page carries the key findings, figures and FAQs.", ""]
for key, label in SERIES:
    out += [f"### {label}", ""]
    for slug, r in cat.items():
        if r.get("series") != key:
            continue
        card = re.search(r'data-report="%s".*?' % re.escape(slug), hub)
        art = hub[hub.rindex("<article", 0, card.start()):hub.index("</article>", card.start())] if card else ""
        lead = re.search(r"</h2>\s*<p>(.*?)</p>", art, re.S)
        eds = ", ".join(NAMES.get(l, l) for l in r.get("editions", {"en": 1}))
        out.append(f"- [{r['sector']}: {r['title']}]({SITE}/pages/report-{slug}): {un(lead.group(1)) if lead else ''} ({eds})")
    out.append("")
if articles:
    out += ["## Insights", ""] + [f"- [{t}]({SITE}/pages/{p}): {d}" for p in articles for t, d in [meta(p)]] + [""]
out += ["## Company", ""] + [f"- [{t}]({SITE}/pages/{p}): {d}" for p in company for t, d in [meta(p)]]
out += ["", "## Languages", "",
        "Every page is published in 26 languages. English is at the root; other editions use a language folder: "
        + ", ".join(f"{n} ({SITE}/{c}/)" for c, n in langs if c) + ".", ""]
open(os.path.join(ROOT, "llms.txt"), "w", encoding="utf-8", newline="\n").write("\n".join(out))
print("llms.txt:", len(practices), "practices,", len(services), "services,", len(cat), "reports,", len(articles), "articles")
