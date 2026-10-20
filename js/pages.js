/* ============================================
   INNER PAGES: FAQ accordion
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

});
