/* ============================================
   INNER PAGES — FAQ accordion + scroll reveals
   Loaded by every page in /pages after main.js.
   ============================================ */
document.addEventListener('DOMContentLoaded', () => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // FAQ: progressive enhancement. Without JS every answer stays visible.
  document.querySelectorAll('.faq-inner').forEach(list => {
    list.querySelectorAll('.faq-item').forEach((item, i) => {
      const q = item.querySelector('h3');
      if (!q) return;
      item.classList.add('faq-acc');
      if (i === 0) item.classList.add('open');
      q.setAttribute('role', 'button');
      q.setAttribute('tabindex', '0');
      q.setAttribute('aria-expanded', String(i === 0));
      const toggle = () => {
        const open = item.classList.toggle('open');
        q.setAttribute('aria-expanded', String(open));
      };
      q.addEventListener('click', toggle);
      q.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  });

  if (reducedMotion) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      en.target.classList.add('in');
      io.unobserve(en.target);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });

  document.querySelectorAll('.svc-item, .insight-card, .rel-head, .faq-inner > h2, .methodology-title, .page-prose h2, .about-page .about-inner')
    .forEach(el => { el.classList.add('rv'); io.observe(el); });
});
