# -*- coding: utf-8 -*-
"""
File a translated batch.

  python i18n/ingest.py <batch-number> [incoming.json]

incoming.json = {"<lang>": {"<segment id>": "<translation>", ...}, ...}
For each language it checks the batch is complete (no missing / unknown ids),
that inline markup (links, emphasis, spans) is identical to the English, and
that nothing was left in English by mistake, then writes
i18n/translations/<lang>/bNN.json.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_IN = os.path.join(os.environ.get("TEMP", "."), "hs_incoming.json")
# segments that are legitimately identical in every language (brand, codes, email)
SAME_OK = {"Heirstone", "Consulting", "Heirstone Consulting", "info@heirstoneconsulting.com",
           "Heirstone Consulting on LinkedIn", "Heirstone Consulting & Strategic Advisory"}


def sig(html):
    return [(m.group(1).lower(), re.sub(r"\s+", " ", m.group(2) or "").strip())
            for m in re.finditer(r"<\s*(/?[a-zA-Z0-9]+)([^>]*)>", html)
            if m.group(1).lower() not in ("br", "/br")]


def main():
    b = int(sys.argv[1])
    src_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_IN
    batches = json.load(open(os.path.join(ROOT, "i18n", "batches.json")))
    seg = json.load(open(os.path.join(ROOT, "i18n", "source.json"), encoding="utf-8"))["segments"]
    want = batches[b - 1]
    incoming = json.load(open(src_path, encoding="utf-8"))
    ok = True
    for lang, d in incoming.items():
        missing = [i for i in want if i not in d]
        extra = [i for i in d if i not in want]
        bad_markup = [i for i in want if i in d and sig(d[i]) != sig(seg[i])]
        untranslated = [i for i in want if i in d and d[i].strip() == seg[i].strip()
                        and re.sub(r"<[^>]+>", "", seg[i]).strip() not in SAME_OK
                        and re.search(r"[A-Za-z]{4,}", re.sub(r"<[^>]+>", "", seg[i]))]
        status = "OK"
        if missing or extra or bad_markup:
            status = "REJECTED"
            ok = False
        print(f"[{lang}] b{b:02d}: {len(d)}/{len(want)} {status}"
              + (f" | missing {missing[:4]}" if missing else "")
              + (f" | unknown {extra[:4]}" if extra else "")
              + (f" | markup changed {bad_markup[:4]}" if bad_markup else "")
              + (f" | identical to English (check): {[seg[i][:30] for i in untranslated[:4]]}" if untranslated else ""))
        if status == "OK":
            out = os.path.join(ROOT, "i18n", "translations", lang)
            os.makedirs(out, exist_ok=True)
            json.dump({i: d[i] for i in want}, open(os.path.join(out, f"b{b:02d}.json"), "w", encoding="utf-8"),
                      ensure_ascii=False, indent=0)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
