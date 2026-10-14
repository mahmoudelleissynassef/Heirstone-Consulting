/* ============================================
   REPORTS — email-gated delivery
   "Get the report" opens the form; the server emails a personal, expiring
   download link to the address entered (POST /api/reports/request). The page
   never exposes the PDF itself, so only a real inbox receives the report.
   ============================================ */
document.addEventListener('DOMContentLoaded', () => {
  const dlg = document.getElementById('reportGate');
  if (!dlg) return;
  const form = dlg.querySelector('.rg-form');
  const done = dlg.querySelector('.rg-done');
  const status = dlg.querySelector('.rg-status');
  const titleEl = dlg.querySelector('.rg-report');
  // Messages live in the page (hidden) so each language edition carries its own translation
  const msg = (k) => (dlg.querySelector(`.rg-msg[data-msg="${k}"]`) || {}).innerHTML || '';
  const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
  // Campaign tags (newsletter, LinkedIn…) travel with the request so the lead alert shows where it came from
  const tags = [...new URLSearchParams(location.search)].filter(([k]) => /^utm_(source|medium|campaign|content)$/.test(k));
  const utm = tags.length ? '?' + new URLSearchParams(tags).toString() : '';
  const picker = dlg.querySelector('.rg-edition');
  let current = null;

  const setStatus = (html, isError) => {
    status.innerHTML = html;
    status.classList.toggle('error', !!isError);
  };
  // Title from the visible (translated) text: the hub card's sector + heading, else the page H1.
  // data-title is English only, so it is just the fallback.
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const reportTitle = (btn) => {
    const card = btn.closest('.rp-card');
    if (card) {
      const tag = txt(card.querySelector('.insight-tag')), h = txt(card.querySelector('h2'));
      if (h) return tag ? `${tag}: ${h}` : h;
    }
    return txt(document.querySelector('main h1, h1')) || btn.dataset.title || '';
  };
  const open = (btn) => {
    current = btn.dataset.report;
    titleEl.textContent = reportTitle(btn);
    // Language picker only for reports published in more than one language; default to the page language
    const eds = (btn.dataset.editions || 'en').split(' ');
    if (picker) {
      picker.hidden = eds.length < 2;
      const pref = (document.documentElement.lang || 'en').slice(0, 2);
      // Russian editions also suit readers of the Kyrgyz and Kazakh pages
      const pick = eds.includes(pref) ? pref : (['ky', 'kk'].includes(pref) && eds.includes('ru') ? 'ru' : 'en');
      picker.querySelectorAll('input[name="edition"]').forEach((i) => { i.checked = i.value === pick; i.closest('label').hidden = !eds.includes(i.value); });
    }
    form.hidden = false;
    done.hidden = true;
    setStatus('', false);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    setTimeout(() => form.querySelector('input[name="name"]').focus(), 60);
  };
  const close = () => {
    if (typeof dlg.close === 'function' && dlg.open) dlg.close(); else dlg.removeAttribute('open');
  };

  document.querySelectorAll('.rp-get').forEach((b) => b.addEventListener('click', () => open(b)));
  dlg.querySelector('.rg-x').addEventListener('click', close);
  dlg.querySelector('.rg-ok').addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // click on the backdrop

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form).entries());
    if (!(d.name || '').trim() || !EMAIL_RE.test((d.email || '').trim()) || !form.elements.consent.checked) {
      setStatus(msg('invalid'), true);
      return;
    }
    const btn = form.querySelector('.rg-submit');
    btn.disabled = true;
    setStatus(msg('sending'), false);
    try {
      const res = await fetch('/api/reports/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          name: d.name, email: (d.email || '').trim(), org: d.org || '', consent: true, _honey: d._honey || '',
          report: current, edition: d.edition || 'en', lang: document.documentElement.lang || 'en', page: location.pathname + utm,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 429) throw new Error('rate');
      if (!res.ok || !out.ok) throw new Error('error');
      dlg.querySelector('.rg-email').textContent = d.email.trim();
      form.reset();  // (the picker is set again on the next open)
      setStatus('', false);
      form.hidden = true;
      done.hidden = false;
    } catch (err) {
      setStatus(msg(err.message === 'rate' ? 'rate' : 'error'), true);
    } finally {
      btn.disabled = false;
    }
  });

  // Deep link: ?report=<slug> opens the form straight away (used in emails and posts)
  const want = new URLSearchParams(location.search).get('report');
  const trigger = want && document.querySelector(`.rp-get[data-report="${CSS.escape(want)}"]`);
  if (trigger) open(trigger);
});

/* ============================================
   REPORTS HUB — geography tabs and tick-box filters
   A tab shows one series (or all); tick boxes narrow by geography and by sector
   (any ticked value within a group, every group must match). #africa,
   #middle-east and #central-asia open the hub on that series.
   ============================================ */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('reportFilter');
  if (!form) return;
  const tabs = [...document.querySelectorAll('[data-geo-tab]')];
  const sections = [...document.querySelectorAll('[data-series-section]')];
  const cards = [...document.querySelectorAll('.rp-card[data-series]')];
  const countEl = form.querySelector('.rp-count-n');
  const clearBtn = form.querySelector('.rp-clear');
  const empty = document.querySelector('.rp-empty');
  const filterSec = document.querySelector('.rp-filter-sec');
  let series = 'all';

  const ticked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const matches = (card, attr, wanted) => !wanted.length || card.dataset[attr].split(' ').some((v) => wanted.includes(v));
  const apply = () => {
    const geo = ticked('geo'), sector = ticked('sector');
    let shown = 0;
    cards.forEach((c) => {
      const ok = (series === 'all' || c.dataset.series === series) && matches(c, 'geo', geo) && matches(c, 'sector', sector);
      c.hidden = !ok;
      if (ok) shown += 1;
    });
    let first = true;
    sections.forEach((s) => {
      s.hidden = !s.querySelector('.rp-card[data-series]:not([hidden])');
      s.classList.toggle('is-first', !s.hidden && first);
      if (!s.hidden) first = false;
    });
    countEl.textContent = shown;
    clearBtn.hidden = !geo.length && !sector.length;
    empty.hidden = shown > 0;
    tabs.forEach((t) => (t.dataset.geoTab === series ? t.setAttribute('aria-current', 'true') : t.removeAttribute('aria-current')));
  };
  const choose = (s) => {
    series = tabs.some((t) => t.dataset.geoTab === s) ? s : 'all';
    apply();
  };

  tabs.forEach((t) => t.addEventListener('click', (e) => {
    e.preventDefault();
    choose(t.dataset.geoTab);
    history.replaceState(null, '', series === 'all' ? location.pathname + location.search : `#${series}`);
    if (filterSec) filterSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  // Phones: the tick boxes fold behind a toggle (labelled with the section's translated aria-label);
  // the count stays visible
  const mq = window.matchMedia('(max-width: 600px)');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'rp-ftoggle';
  toggle.setAttribute('aria-controls', 'reportFilter');
  toggle.setAttribute('aria-expanded', 'false');
  const toggleLabel = () => {
    const n = ticked('geo').length + ticked('sector').length;
    const base = (filterSec && filterSec.getAttribute('aria-label')) || 'Filter';
    toggle.textContent = n ? `${base} (${n})` : base;
  };
  const fold = () => {
    toggle.hidden = !mq.matches;
    form.classList.toggle('is-collapsed', mq.matches && toggle.getAttribute('aria-expanded') !== 'true');
  };
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-expanded', toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    fold();
  });
  if (filterSec) filterSec.querySelector('.rp-inner').prepend(toggle);
  if (mq.addEventListener) mq.addEventListener('change', fold);
  toggleLabel();
  fold();

  form.addEventListener('change', () => { apply(); toggleLabel(); });
  clearBtn.addEventListener('click', () => { form.reset(); apply(); toggleLabel(); });
  window.addEventListener('hashchange', () => choose(location.hash.slice(1)));
  choose(location.hash.slice(1));
});
