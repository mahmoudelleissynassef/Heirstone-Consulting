# -*- coding: utf-8 -*-
"""Tell Bing, Yandex, Naver, Seznam and Yep (IndexNow) which pages are new or changed, so they recrawl them
within hours instead of weeks. Google does not use IndexNow; it reads the sitemap in Search Console.

  python tools/indexnow.py                     every URL in sitemap.xml (after a big release)
  python tools/indexnow.py --changed HEAD~1    only pages changed since that commit (all languages)
  python tools/indexnow.py --dry-run ...       list the URLs without sending

Run it after the deploy is live: the key file /<KEY>.txt must be reachable on the site first.
"""
import json, os, re, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://www.heirstoneconsulting.com"
KEY = "d445e9efd718b54e237d9d7c750998d6"  # public by design; the matching file is /<KEY>.txt


def sitemap_urls():
    return re.findall(r"<loc>([^<]+)</loc>", open(os.path.join(ROOT, "sitemap.xml"), encoding="utf-8").read())


def changed_urls(since):
    files = subprocess.run(["git", "-C", ROOT, "diff", "--name-only", since, "--", "*.html"],
                           capture_output=True, text=True).stdout.split()
    want = set()
    for f in files:
        if "404" in f:
            continue
        path = "/" + re.sub(r"(^|/)index\.html$", r"\1", f).removesuffix(".html")
        want.add(SITE + path)
    return [u for u in sitemap_urls() if u in want]


def main():
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    urls = changed_urls(args[args.index("--changed") + 1]) if "--changed" in args else sitemap_urls()
    print(len(urls), "URLs")
    if "--dry-run" in sys.argv:
        print("\n".join(urls[:20]) + ("\n..." if len(urls) > 20 else ""))
        return
    for i in range(0, len(urls), 10000):
        body = json.dumps({"host": "www.heirstoneconsulting.com", "key": KEY, "keyLocation": f"{SITE}/{KEY}.txt",
                           "urlList": urls[i:i + 10000]}).encode()
        req = urllib.request.Request("https://api.indexnow.org/indexnow", data=body, method="POST",
                                     headers={"Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print("IndexNow:", r.status, "(200/202 = accepted)")
        except urllib.error.HTTPError as e:
            print("IndexNow:", e.code, e.read()[:200])


if __name__ == "__main__":
    main()
