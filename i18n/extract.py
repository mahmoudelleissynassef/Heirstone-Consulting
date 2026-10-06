# -*- coding: utf-8 -*-
"""
Extract every translatable segment from the English site.

Segments are taken at block level: an element whose children are all inline
(a, em, strong, span, br...) becomes ONE segment with its inline tags kept, so
translators can reorder words around links and emphasis. Attributes that people
see or hear (alt, title, aria-label, placeholder, meta descriptions, og/twitter
text) and human-readable JSON-LD fields are extracted too, plus the UI strings
used by the site's JavaScript.

Output: i18n/source.json  ->  {"segments": {id: english}, "pages": [...], "js": [...]}
"""
import json, re, hashlib, os, glob
from bs4 import BeautifulSoup, NavigableString, Comment, Doctype

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

INLINE = {"a", "em", "strong", "b", "i", "span", "br", "sup", "sub", "small", "abbr", "u", "mark", "time"}
SKIP = {"script", "style", "noscript", "svg", "template", "code", "pre"}
ATTRS = ("alt", "title", "aria-label", "placeholder", "aria-roledescription")
META_TEXT = {"description", "twitter:title", "twitter:description", "og:title", "og:description",
             "og:image:alt", "twitter:image:alt", "og:site_name"}
LD_KEYS = {"name", "description", "text", "headline", "alternateName", "slogan", "jobTitle",
           "addressLocality", "addressCountry", "areaServed", "knowsAbout", "serviceType", "about", "caption", "abstract"}

# strings the site's JavaScript writes into the page
JS_STRINGS = [
    "Sending…", "Message Sent",
    "Thank you — your message has been sent. We typically respond within one business day.",
    'Something went wrong and your message was not sent. Please email us directly at <a href="mailto:info@heirstoneconsulting.com">info@heirstoneconsulting.com</a>.',
    "Open menu", "Close menu", "Language",
]


def pages():
    out = [os.path.join(ROOT, "index.html"), os.path.join(ROOT, "404.html")]
    out += sorted(glob.glob(os.path.join(ROOT, "pages", "*.html")))
    return out


def has_letters(s):
    return bool(re.search(r"[A-Za-z]", s))


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def sid(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def inner_html(el):
    return norm("".join(str(c) for c in el.contents))


def is_inline_only(el):
    for d in el.descendants:
        if getattr(d, "name", None) and d.name not in INLINE:
            return False
    return True


def walk(el, found):
    for child in list(el.children):
        if isinstance(child, (Comment, Doctype)):
            continue
        if isinstance(child, NavigableString):
            t = norm(str(child))
            if t and has_letters(t):
                found.append(t)
            continue
        if child.name in SKIP or child.has_attr("data-i18n-skip"):
            continue
        direct_text = any(isinstance(c, NavigableString) and norm(str(c)) for c in child.children)
        if child.name not in INLINE and direct_text and is_inline_only(child):
            h = inner_html(child)
            if has_letters(re.sub(r"<[^>]+>", "", h)):
                found.append(h)
            continue
        walk(child, found)


def ld_strings(obj, found):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in LD_KEYS and isinstance(v, str) and has_letters(v):
                found.append(norm(v))
            elif k in LD_KEYS and isinstance(v, list):
                found += [norm(x) for x in v if isinstance(x, str) and has_letters(x)]
            else:
                ld_strings(v, found)
    elif isinstance(obj, list):
        for v in obj:
            ld_strings(v, found)


def extract_page(path):
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "html.parser")
    found = []
    if soup.title and soup.title.string:
        found.append(norm(soup.title.string))
    for m in soup.find_all("meta"):
        key = m.get("name") or m.get("property")
        if key in META_TEXT and m.get("content") and has_letters(m["content"]):
            found.append(norm(m["content"]))
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            ld_strings(json.loads(s.string), found)
        except Exception:
            pass
    for el in soup.find_all(True):
        if el.has_attr("data-i18n-skip") or el.find_parent(attrs={"data-i18n-skip": True}):
            continue
        for a in ATTRS:
            v = el.get(a)
            if isinstance(v, str) and has_letters(v):
                found.append(norm(v))
        if el.name == "input" and el.get("type") in ("submit", "button") and el.get("value"):
            found.append(norm(el["value"]))
    if soup.body:
        walk(soup.body, found)
    return found


def main():
    segs, per_page = {}, []
    for p in pages():
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        ids = []
        for t in extract_page(p):
            i = sid(t)
            segs[i] = t
            ids.append(i)
        per_page.append({"page": rel, "segments": sorted(set(ids))})
    for t in JS_STRINGS:
        segs[sid(t)] = t
    json.dump({"segments": segs, "pages": per_page, "js": [sid(t) for t in JS_STRINGS]},
              open(os.path.join(ROOT, "i18n", "source.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    words = sum(len(re.sub(r"<[^>]+>", " ", t).split()) for t in segs.values())
    print(f"{len(per_page)} pages | {len(segs)} unique segments | {words:,} unique words")


if __name__ == "__main__":
    main()
