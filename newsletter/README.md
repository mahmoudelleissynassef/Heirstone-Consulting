# Heirstone newsletter

**The Heirstone Brief** (English) and **La Lettre Heirstone** (French): a monthly research email built from the
reports. Each issue has one featured report with three key figures, three short findings, more reports, a note
and a call to action. Suggested slot: the first Tuesday of the month, 10:00 Dubai (same window as LinkedIn).

## How it fits together

```
 Report form on the website ─► server.js ─┬─► email to the visitor with the download link (as before)
 (consent box: "I agree to receive this    ├─► Resend contact: segment "Heirstone Newsletter",
  report and occasional Heirstone          │   EN or FR topic = the edition they chose
  research by email")                      ├─► alert to info@: who, which report, language, date and time,
                                           │   newsletter outcome, campaign source
                                           └─► visitor clicks the link ─► "Report downloaded" alert to info@

 OneDrive workbook ─► nl.py contacts sync ─► Resend (same segment and topics)

 issues/YYYY-MM.json ─► nl.py render / test / draft ─► two Resend broadcast drafts (EN topic, FR topic)
                                                      └─► you review, test and press Send / Schedule in Resend
 Unsubscribes and preference changes: handled by Resend (link in every issue), applied before every send.
```

**Resend is the master list.** It is the only place that sees both website sign-ups and unsubscribes, so the
workbook is an input to it rather than a copy of it.

## Where things live

| What | Where |
|---|---|
| Live list (everyone, incl. unsubscribes) | Resend → Audience → Contacts, segment **Heirstone Newsletter** |
| Contacts you add yourself | `OneDrive - Heirstone Consulting/Documents/05_Heirstone Consulting/05_Newsletter/Heirstone Newsletter Contacts.xlsx` (never in this repo: it is public on GitHub) |
| Issue content | `newsletter/issues/YYYY-MM.json` (EN and FR side by side) |
| Template | `render()` in `newsletter/nl.py`. Fixed wording is in `LABELS`, colours in the brand constants |
| Email images | `Media/email/` (logo, report covers as JPG: Outlook can't show WebP). FR covers are page 1 of the French PDF |
| IDs, sender, names, postal address | `newsletter/config.json` |
| Sign-up and alert code | `server.js`, sections "newsletter list" and "owner notifications" |

`/newsletter/*` is never served by the website.

## Your contact list

**Add people:** open the workbook, add one row per person, save, then run (or ask Claude to "sync the newsletter contacts"):

```
python newsletter/nl.py contacts sync "C:\Users\melle\OneDrive - Heirstone Consulting\Documents\05_Heirstone Consulting\05_Newsletter\Heirstone Newsletter Contacts.xlsx"
```

- Columns: `email`, `first_name` (the greeting), `last_name`, `organisation`, `language` (`en`/`fr`, blank = en),
  `source`, `action`, `notes` (not uploaded).
- `source` is required and must be one of `client`, `met-in-person`, `asked-to-subscribe`, `report-request`.
  It records why we may email them. Rows without one are skipped.
- To stop sending to someone, write `unsubscribe` in `action`. They stay on file so nothing re-adds them.
- Re-running is safe: existing contacts are updated, never duplicated. Anyone who unsubscribed is never re-added,
  and a person's edition choice is left alone. `--dry-run` shows what would happen without changing anything.
- Each run writes `… .last-sync.csv` next to the workbook with a result per row.
- **See everyone** (website sign-ups included): `python newsletter/nl.py contacts export "<path>.xlsx"`, or look in Resend.

**Don't add cold contacts** (the BD target list, RocketReach or LinkedIn exports, bought lists). Write to them one to
one and point them to a report; downloading it signs them up properly. Two reasons. First, the law: GDPR (Cyprus,
Greece), the UAE and Egyptian data protection laws and South Africa's POPIA generally require consent for marketing email. Second,
deliverability: bounces and spam complaints can get the Resend account suspended. That one account also sends the
report emails and contact-form messages for Heirstone and five other ventures.

## Sending an issue (monthly)

1. **Write** `newsletter/issues/YYYY-MM.json`. Copy the last issue and change it, or ask Claude to draft it from the
   newest reports. Every figure needs a page reference in the English edition, and the French should follow the
   official French report wording. Report titles, covers, summaries and links come from the catalog automatically.
2. **Preview:** `python newsletter/nl.py render YYYY-MM` writes `newsletter/out/YYYY-MM.{en,fr}.preview.html`.
3. **Test:** `python newsletter/nl.py test YYYY-MM --to you@heirstoneconsulting.com --name Mahmoud`. Check it in
   Outlook desktop and on a phone.
4. **Deploy the images:** commit `Media/email/` and push, because the email loads them from the website.
5. **Draft:** `python newsletter/nl.py draft YYYY-MM` creates the EN and FR broadcasts in Resend (not sent). It
   refuses if the images aren't live yet, and won't create drafts twice for the same issue.
6. **Send (you):** Resend → Broadcasts → open each draft → Send test → **Schedule**.

Local commands need a **full-access** Resend API key in `RESEND_API_KEY` (or `~/.heirstone/resend_api_key`).
Sending is always your click in Resend; the tool only creates drafts.

## Alerts you receive at info@

- **Report request:** name, email, organisation, report, edition language, *Requested: Tuesday 3 November 2026,
  10:42 Cairo time (GMT+2)*, newsletter outcome (added / already on the list / unsubscribed earlier, so not
  re-added / not set up), where they came from (e.g. *Newsletter: brief-01-hotels*, or LinkedIn), page and
  site language. Plus the private CSV link to every lead.
- **Report downloaded:** the first time each person downloads each edition, with the download time and when the
  link was sent. Opens within 20 seconds of the email being sent are treated as company mail filters
  (Mimecast, Proofpoint, Defender) testing the link: they're logged but don't trigger an alert. Re-downloads
  don't alert either. Set `NOTIFY_DOWNLOADS=off` on Railway to stop these.

The time zone is `NOTIFY_TZ` (default `Africa/Cairo`; use `Asia/Dubai` for Dubai time).

## One-time setup (status)

- [ ] **Resend objects:** `python newsletter/nl.py setup` creates the segment *Heirstone Newsletter*, two private
      topics (*The Heirstone Brief (English)*, default in; *La Lettre Heirstone (français)*, default out) and 8
      contact fields, then writes the IDs into `config.json`. This uses 1 of the account's 3 segments, which are
      shared by all ventures.
- [ ] **Deploy** `config.json` with the IDs. Until it has a segment ID, sign-ups are switched off and the alert says
      "not set up yet"; nothing else changes.
- [ ] **Check the Railway API key has full access.** Contacts need it. A sending-only key still delivers reports, but
      every alert will say "Not added (lookup returned 401)".
- [ ] **Postal address** in `config.json` → `postal_address`. US law (CAN-SPAM) requires one in marketing email,
      and it reads as more credible anyway.
- [ ] Optional: send issues from a subdomain (e.g. `news.heirstoneconsulting.com`). This keeps newsletter reputation
      apart from report and contact-form mail. It needs DNS records at GoDaddy.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `newsletter/config.json` → `resend.segment_id`, `resend.topics.en/fr` | empty (off) | The list. Env `NEWSLETTER_SEGMENT_ID`, `NEWSLETTER_TOPIC_EN`, `NEWSLETTER_TOPIC_FR` override |
| `NOTIFY_TZ` | `Africa/Cairo` | Time zone in alerts |
| `NOTIFY_DOWNLOADS` | on | `off` stops download alerts |
| `RESEND_API_URL` | `https://api.resend.com` | Tests point this at a mock |

## Limits worth knowing

- **Plan:** the current Resend plan holds 1,000 contacts. More needs a paid marketing tier.
- **Shared account:** "unsubscribed" in Resend is account-wide. Someone who unsubscribes from another venture's
  broadcasts would also stop receiving Heirstone's. If the ventures' lists grow, give each one its own Resend team.
- **Switching edition:** the topics are private, so readers see only their own edition on the preferences page. To
  switch they reply ("French"/"anglais"), and you change it in Resend or with `contacts sync`.
- **Languages:** issues go out in English and French. Visitors who read the site in any other language get English
  unless they chose the French edition of a report.
- **Measurement:** Resend open and click tracking is off for the domain, and the site has no analytics. What you
  can see: replies, unsubscribes, and report requests tagged *Newsletter: <campaign>* in the alerts.
