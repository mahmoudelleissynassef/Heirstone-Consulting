# -*- coding: utf-8 -*-
"""Split source segments into ~1,300-word batches in document order; print one batch for translation."""
import json, re, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract as ex

src = json.load(open(os.path.join(ex.ROOT, "i18n", "source.json"), encoding="utf-8"))
seg = src["segments"]
order, seen = [], set()
for path in ex.pages():
    for t in ex.extract_page(path):
        i = ex.sid(t)
        if i not in seen:
            seen.add(i); order.append(i)
for i in src["js"]:
    if i not in seen:
        seen.add(i); order.append(i)
assert len(order) == len(seg)
batches, cur, w = [], [], 0
for i in order:
    n = len(re.sub(r"<[^>]+>", " ", seg[i]).split())
    if cur and w + n > 1300:
        batches.append(cur); cur, w = [], 0
    cur.append(i); w += n
batches.append(cur)
json.dump(batches, open(os.path.join(ex.ROOT, "i18n", "batches.json"), "w"), indent=0)
if len(sys.argv) > 1:
    b = int(sys.argv[1])
    for i in batches[b - 1]:
        print(json.dumps({i: seg[i]}, ensure_ascii=False)[1:-1])
else:
    print(len(batches), "batches:", [len(b) for b in batches])
