# -*- coding: utf-8 -*-
"""
Build the translated site.

For every English page and every language:
  * inject the language switcher + hreflang alternates (English pages are updated
    in place with a minimal, idempotent string edit),
  * for non-English: translate every segment found by extract.py (text, inline
    HTML, titles, meta, alt/aria/title/placeholder, JSON-LD, JS UI strings),
  * rewrite links so navigation stays inside the language, assets stay shared,
  * set <html lang>, og:locale, canonical, per-language fonts,
  * write /<lang>/<same path>.

The build FAILS if any segment on any page has no translation, or if a
translation changed the inline markup (links, emphasis) of its source.

Usage: python i18n/build.py            (build all)
       python i18n/build.py --check    (report coverage only, write nothing)
"""
import os, re, sys, json, glob, datetime
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup, NavigableString

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract as ex

ROOT = ex.ROOT
SITE = "https://www.heirstoneconsulting.com"

ORDER = ["en", "zh", "ja", "es", "fr", "it", "pt", "de", "fi", "da", "ro", "ru", "ky", "kk", "tr"]
CJK_FONTS = "family=Noto+Serif+{v}:wght@500;600;700&family=Noto+Sans+{v}:wght@300;400;500;600;700"
CYR_FONTS = "family=Noto+Serif:wght@500;600;700&family=Noto+Sans:wght@300;400;500;600;700"
L = {
    "en": dict(name="English", html="en", og="en_GB"),
    "zh": dict(name="中文", html="zh-Hans", og="zh_CN", fonts=CJK_FONTS.format(v="SC"),
               serif="'Playfair Display', 'Noto Serif SC', serif", sans="'Libre Franklin', 'Noto Sans SC', sans-serif"),
    "ja": dict(name="日本語", html="ja", og="ja_JP", fonts=CJK_FONTS.format(v="JP"),
               serif="'Playfair Display', 'Noto Serif JP', serif", sans="'Libre Franklin', 'Noto Sans JP', sans-serif"),
    "es": dict(name="Español", html="es", og="es_ES"),
    "fr": dict(name="Français", html="fr", og="fr_FR"),
    "it": dict(name="Italiano", html="it", og="it_IT"),
    "pt": dict(name="Português", html="pt", og="pt_PT"),
    "de": dict(name="Deutsch", html="de", og="de_DE"),
    "fi": dict(name="Suomi", html="fi", og="fi_FI"),
    "da": dict(name="Dansk", html="da", og="da_DK"),
    "ro": dict(name="Română", html="ro", og="ro_RO"),
    "ru": dict(name="Русский", html="ru", og="ru_RU", fonts=CYR_FONTS,
               serif="'Noto Serif', serif", sans="'Noto Sans', sans-serif"),
    "ky": dict(name="Кыргызча", html="ky", og="ky_KG", fonts=CYR_FONTS,
               serif="'Noto Serif', serif", sans="'Noto Sans', sans-serif"),
    "kk": dict(name="Қазақша", html="kk", og="kk_KZ", fonts=CYR_FONTS,
               serif="'Noto Serif', serif", sans="'Noto Sans', sans-serif"),
    "tr": dict(name="Türkçe", html="tr", og="tr_TR"),
}

GLOBE = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
         '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>')


# ------------------------------------------------------------------ paths
def page_url(rel):
    """English clean URL path for a source file."""
    if rel == "index.html":
        return "/"
    return "/" + rel[:-5]


def lang_url(lang, path):
    if lang == "en":
        return path
    return f"/{lang}/" if path == "/" else f"/{lang}{path}"


def out_path(lang, rel):
    return os.path.join(ROOT, rel) if lang == "en" else os.path.join(ROOT, lang, rel)


# ------------------------------------------------------------------ translations
def load_tr(lang):
    d = {}
    for f in sorted(glob.glob(os.path.join(ROOT, "i18n", "translations", lang, "*.json"))):
        d.update(json.load(open(f, encoding="utf-8")))
    return d


def tag_sig(html):
    """Inline markup signature: tag names + their attributes, in order."""
    return [(m.group(1).lower(), re.sub(r"\s+", " ", m.group(2) or "").strip())
            for m in re.finditer(r"<\s*(/?[a-zA-Z0-9]+)([^>]*)>", html)
            if m.group(1).lower() not in ("br", "/br")]


# ------------------------------------------------------------------ injected blocks (switcher, alternates)
ALT_RE = re.compile(r"\s*<!-- i18n:alternates -->.*?<!-- /i18n:alternates -->", re.S)
SW_RE = re.compile(r"\s*<!-- i18n:switch -->.*?<!-- /i18n:switch -->", re.S)
MSW_RE = re.compile(r"\s*<!-- i18n:mswitch -->.*?<!-- /i18n:mswitch -->", re.S)


def strip_injected(html):
    return MSW_RE.sub("", SW_RE.sub("", ALT_RE.sub("", html)))


def alternates(rel):
    path = page_url(rel)
    out = ["<!-- i18n:alternates -->"]
    for l in ORDER:
        out.append(f'<link rel="alternate" hreflang="{L[l]["html"]}" href="{SITE}{lang_url(l, path)}" />')
    out.append(f'<link rel="alternate" hreflang="x-default" href="{SITE}{path}" />')
    out.append("<!-- /i18n:alternates -->")
    return "\n  " + "\n  ".join(out)


def switcher(rel, lang, label):
    path = page_url(rel)
    links = "".join(
        f'<a href="{lang_url(l, path)}" hreflang="{L[l]["html"]}" lang="{L[l]["html"]}" data-lang="{l}"'
        + (' aria-current="true"' if l == lang else "") + f'>{L[l]["name"]}</a>'
        for l in ORDER)
    desk = (f'\n      <!-- i18n:switch --><li class="dropdown lang-switch" data-i18n-skip>'
            f'<button class="lang-btn" type="button" aria-haspopup="true" aria-label="{label}">{GLOBE}'
            f'<span>{lang.upper()}</span></button><div class="dropdown-menu lang-menu">{links}</div></li><!-- /i18n:switch -->')
    mob = (f'\n    <!-- i18n:mswitch --><div class="mobile-lang" data-i18n-skip aria-label="{label}">{links}</div>'
           f'<!-- /i18n:mswitch -->')
    return desk, mob


def inject(html, rel, lang, label):
    """String-level injection so English sources keep their exact formatting."""
    html = strip_injected(html)
    i = html.index("</head>")
    html = html[:i].rstrip() + alternates(rel) + "\n" + html[i:]
    desk, mob = switcher(rel, lang, label)
    nav = html.find('<ul class="navbar-nav">')
    if nav >= 0:
        end = html.index("</ul>", nav)
        html = html[:end].rstrip() + desk + "\n    " + html[end:]
    m = html.find('<div class="mobile-nav" id="mobileNav">')
    if m >= 0:
        end = html.index("</div>", m)
        html = html[:end].rstrip() + mob + "\n  " + html[end:]
    return html


# ------------------------------------------------------------------ translate a parsed page
def T(tr, text, where, errors):
    k = ex.sid(text)
    v = tr.get(k)
    if v is None:
        errors.append(f"missing {k} [{where}]: {text[:80]}")
        return text
    return v


def translate_soup(soup, tr, errors, where):
    if soup.title and soup.title.string:
        soup.title.string = T(tr, ex.norm(soup.title.string), where, errors)
    for m in soup.find_all("meta"):
        key = m.get("name") or m.get("property")
        if key in ex.META_TEXT and m.get("content") and ex.has_letters(m["content"]):
            m["content"] = T(tr, ex.norm(m["content"]), where, errors)
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(s.string)
        except Exception:
            continue

        def walk_ld(o):
            if isinstance(o, dict):
                for k2, v in list(o.items()):
                    if k2 in ex.LD_KEYS and isinstance(v, str) and ex.has_letters(v):
                        o[k2] = T(tr, ex.norm(v), where + " ld", errors)
                    elif k2 in ex.LD_KEYS and isinstance(v, list):
                        o[k2] = [T(tr, ex.norm(x), where + " ld", errors)
                                 if isinstance(x, str) and ex.has_letters(x) else x for x in v]
                    else:
                        walk_ld(v)
            elif isinstance(o, list):
                for v in o:
                    walk_ld(v)
        walk_ld(data)
        s.string = "\n" + json.dumps(data, ensure_ascii=False, indent=2) + "\n  "
    for el in soup.find_all(True):
        if el.has_attr("data-i18n-skip") or el.find_parent(attrs={"data-i18n-skip": True}):
            continue
        for a in ex.ATTRS:
            v = el.get(a)
            if isinstance(v, str) and ex.has_letters(v):
                el[a] = T(tr, ex.norm(v), where + " @" + a, errors)
        if el.name == "input" and el.get("type") in ("submit", "button") and el.get("value"):
            el["value"] = T(tr, ex.norm(el["value"]), where, errors)
    if soup.body:
        walk_body(soup.body, tr, errors, where)


def walk_body(el, tr, errors, where):
    for child in list(el.children):
        if isinstance(child, (ex.Comment, ex.Doctype)):
            continue
        if isinstance(child, NavigableString):
            raw = str(child)
            t = ex.norm(raw)
            if t and ex.has_letters(t):
                lead = raw[: len(raw) - len(raw.lstrip())]
                trail = raw[len(raw.rstrip()):]
                child.replace_with(NavigableString(lead + T(tr, t, where, errors) + trail))
            continue
        if child.name in ex.SKIP or child.has_attr("data-i18n-skip"):
            continue
        direct = any(isinstance(c, NavigableString) and ex.norm(str(c)) for c in child.children)
        if child.name not in ex.INLINE and direct and ex.is_inline_only(child):
            src = ex.inner_html(child)
            if ex.has_letters(re.sub(r"<[^>]+>", "", src)):
                dst = T(tr, src, where, errors)
                if tag_sig(dst) != tag_sig(src):
                    errors.append(f"markup changed {ex.sid(src)} [{where}]: {src[:60]} -> {dst[:60]}")
                child.clear()
                frag = BeautifulSoup(dst, "html.parser")
                for node in list(frag.contents):
                    child.append(node)
            continue
        walk_body(child, tr, errors, where)


# ------------------------------------------------------------------ links
def is_page_path(p):
    last = p.rsplit("/", 1)[-1]
    return p.endswith("/") or "." not in last or last.endswith(".html")


def clean(p):
    if p.endswith(".html"):
        p = p[:-5]
    if p.endswith("/index"):
        p = p[:-5]
    return p or "/"


def rewrite(url, base, lang):
    if not url or url.startswith(("#", "mailto:", "tel:", "javascript:", "data:", "//")):
        return url
    if url.startswith("http"):
        u = urlparse(url)
        if u.netloc.endswith("heirstoneconsulting.com") and is_page_path(u.path or "/"):
            return SITE + lang_url(lang, clean(u.path or "/")) + (("#" + u.fragment) if u.fragment else "")
        return url
    absu = urlparse(urljoin("https://x" + base, url))
    p = absu.path or "/"
    frag = ("#" + absu.fragment) if absu.fragment else ""
    q = ("?" + absu.query) if absu.query else ""
    if is_page_path(p):
        return lang_url(lang, clean(p)) + q + frag
    return p + q + frag


def rewrite_links(soup, rel, lang):
    base = page_url(rel)
    if not base.endswith("/"):
        base = base.rsplit("/", 1)[0] + "/"
    for el in soup.find_all(True):
        if el.find_parent(attrs={"data-i18n-skip": True}) or el.has_attr("data-i18n-skip"):
            continue
        for a in ("href", "src", "action", "poster"):
            if el.has_attr(a):
                if el.name == "link" and el.get("rel") and ("alternate" in el.get("rel") or "canonical" in el.get("rel")):
                    continue
                el[a] = rewrite(el[a], base, lang)
        if el.has_attr("srcset"):
            el["srcset"] = ", ".join(
                " ".join([rewrite(part.split()[0], base, lang)] + part.split()[1:])
                for part in el["srcset"].split(","))
        if el.has_attr("style") and "url(" in el["style"]:
            el["style"] = re.sub(r"url\((['\"]?)([^'\")]+)\1\)",
                                 lambda m: f"url({m.group(1)}{rewrite(m.group(2), base, lang)}{m.group(1)})",
                                 el["style"])
    for m in soup.find_all("meta"):
        if (m.get("property") or m.get("name")) in ("og:url", "twitter:url") and m.get("content"):
            m["content"] = rewrite(m["content"], base, lang)


# ------------------------------------------------------------------ head extras
def finish_head(soup, rel, lang, tr, src):
    soup.html["lang"] = L[lang]["html"]
    head = soup.head
    canon = head.find("link", rel="canonical")
    if canon:
        canon["href"] = SITE + lang_url(lang, page_url(rel))
    loc = head.find("meta", property="og:locale")
    if not loc:
        loc = soup.new_tag("meta", property="og:locale")
        head.append(loc)
    loc["content"] = L[lang]["og"]
    if L[lang].get("fonts"):
        link = soup.new_tag("link", rel="stylesheet",
                            href=f"https://fonts.googleapis.com/css2?{L[lang]['fonts']}&display=swap")
        style = soup.new_tag("style")
        style.string = f":root{{--f-serif:{L[lang]['serif']};--f-sans:{L[lang]['sans']};}}"
        head.append(link)
        head.append(style)
    ui = {src["segments"][i]: tr[i] for i in src["js"] if i in tr}
    main = soup.find("script", src=re.compile(r"main\.js$"))
    if main:
        s = soup.new_tag("script")
        s.string = "window.HS_I18N=" + json.dumps(ui, ensure_ascii=False) + ";"
        main.insert_before(s)
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string)
        except Exception:
            continue
        objs = data.get("@graph", [data]) if isinstance(data, dict) else data
        for o in objs if isinstance(objs, list) else [objs]:
            if isinstance(o, dict) and o.get("@type") in ("WebSite", "WebPage", "Article", "BlogPosting", "FAQPage"):
                o["inLanguage"] = L[lang]["html"]
            if isinstance(o, dict) and isinstance(o.get("url"), str):
                o["url"] = rewrite(o["url"], "/", lang)
        script.string = "\n" + json.dumps(data, ensure_ascii=False, indent=2) + "\n  "


# ------------------------------------------------------------------ main
def write_sitemap(lastmod):
    """Rebuild sitemap.xml: every English URL (priority kept) in every language,
    each entry carrying the full set of hreflang alternates."""
    path = os.path.join(ROOT, "sitemap.xml")
    old = open(path, encoding="utf-8").read()
    entries = []
    for block in re.findall(r"<url>(.*?)</url>", old, re.S):
        loc = re.search(r"<loc>([^<]+)</loc>", block).group(1)
        p = loc[len(SITE):] or "/"
        if p.strip("/").split("/")[0] in ORDER:
            continue  # language copy from a previous build
        pr = re.search(r"<priority>([^<]+)</priority>", block)
        entries.append((p, pr.group(1) if pr else "0.7"))
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">']
    for p, pr in entries:
        alts = [f'    <xhtml:link rel="alternate" hreflang="{L[l]["html"]}" href="{SITE}{lang_url(l, p)}"/>' for l in ORDER]
        alts.append(f'    <xhtml:link rel="alternate" hreflang="x-default" href="{SITE}{p}"/>')
        for l in ORDER:
            out.append(f"  <url><loc>{SITE}{lang_url(l, p)}</loc><lastmod>{lastmod}</lastmod>"
                       f"<changefreq>monthly</changefreq><priority>{pr}</priority>")
            out.extend(alts)
            out.append("  </url>")
    out.append("</urlset>\n")
    open(path, "w", encoding="utf-8", newline="").write("\n".join(out))
    return len(entries) * len(ORDER)


def main(check=False):
    src = json.load(open(os.path.join(ROOT, "i18n", "source.json"), encoding="utf-8"))
    label_id = ex.sid("Language")
    pages = [os.path.relpath(p, ROOT).replace("\\", "/") for p in ex.pages()]
    trs = {l: load_tr(l) for l in ORDER if l != "en"}
    all_errors, written = {}, 0
    only = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")]
    only = only[0].split(",") if only else ORDER
    for lang in ORDER:
        if lang not in only:
            continue
        errors = []
        tr = trs.get(lang, {})
        if lang != "en":
            missing = [i for i in src["segments"] if i not in tr]
            if missing:
                errors.append(f"{len(missing)} of {len(src['segments'])} segments untranslated")
        for rel in pages:
            eng = open(os.path.join(ROOT, rel), encoding="utf-8").read()
            label = "Language" if lang == "en" else tr.get(label_id, "Language")
            html = inject(eng, rel, lang, label)
            if lang == "en":
                if not check and html != eng:
                    open(os.path.join(ROOT, rel), "w", encoding="utf-8", newline="").write(html)
                    written += 1
                continue
            soup = BeautifulSoup(html, "html.parser")
            translate_soup(soup, tr, errors, rel)
            rewrite_links(soup, rel, lang)
            finish_head(soup, rel, lang, tr, src)
            if not check:
                dst = out_path(lang, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                open(dst, "w", encoding="utf-8", newline="").write(str(soup))
                written += 1
        if errors:
            all_errors[lang] = errors
    for lang, errs in all_errors.items():
        uniq = sorted(set(errs))
        print(f"[{lang}] {len(uniq)} problem(s)")
        for e in uniq[:8]:
            print("   ", e)
    if not check and not all_errors and only == ORDER:
        print(f"sitemap.xml: {write_sitemap(datetime.date.today().isoformat())} URLs")
    print(f"{'checked' if check else 'wrote'} {written} files; "
          f"{'OK' if not all_errors else 'INCOMPLETE: ' + ', '.join(all_errors)}")
    return 0 if not all_errors else 1


if __name__ == "__main__":
    sys.exit(main(check="--check" in sys.argv))
