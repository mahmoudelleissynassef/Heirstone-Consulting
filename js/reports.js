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
      const pick = eds.includes(pref) ? pref : 'en';
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
          report: current, edition: d.edition || 'en', lang: document.documentElement.lang || 'en', page: location.pathname,
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
