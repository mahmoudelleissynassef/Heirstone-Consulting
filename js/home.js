/* ============================================
   HOMEPAGE — carousel, practices explorer, timeline, reveals
   Loaded only by index.html, after main.js.
   ============================================ */
document.addEventListener('DOMContentLoaded', () => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------- engagements carousel
  const track = document.querySelector('.eng-track');
  if (track) {
    const cards = [...track.querySelectorAll('.eng-card')];
    const prev = document.querySelector('.eng-prev');
    const next = document.querySelector('.eng-next');
    const cur = document.querySelector('.eng-cur');
    const bar = document.querySelector('.eng-progress span');
    // Direction-aware: in Arabic (rtl) the first card sits at the right and the track scrolls leftwards.
    const rtl = getComputedStyle(track).direction === 'rtl';
    const pad = () => parseFloat(getComputedStyle(track)[rtl ? 'scrollPaddingRight' : 'scrollPaddingLeft']) || 0;
    // distance from a card's leading edge to the track's leading edge (+ snap padding)
    const offset = (c) => {
      const t = track.getBoundingClientRect(), r = c.getBoundingClientRect();
      return rtl ? (t.right - pad()) - r.right : r.left - (t.left + pad());
    };
    let index = 0;

    const nearest = () => {
      let best = 0, dist = Infinity;
      cards.forEach((c, i) => {
        const d = Math.abs(offset(c));
        if (d < dist) { dist = d; best = i; }
      });
      // at the far end the last cards can't snap to the leading edge
      if (Math.abs(track.scrollLeft) >= track.scrollWidth - track.clientWidth - 4) best = cards.length - 1;
      return best;
    };

    const update = () => {
      index = nearest();
      cards.forEach((c, i) => c.classList.toggle('is-current', i === index));
      if (cur) cur.textContent = String(index + 1).padStart(2, '0');
      if (bar) bar.style.width = ((index + 1) / cards.length * 100) + '%';
      if (prev) prev.disabled = index === 0;
      if (next) next.disabled = index === cards.length - 1;
    };

    const go = (i) => {
      const k = Math.max(0, Math.min(cards.length - 1, i));
      const dx = offset(cards[k]);
      track.scrollBy({ left: rtl ? -dx : dx, behavior: reducedMotion ? 'auto' : 'smooth' });
    };

    let timer = null, visible = false, stopped = reducedMotion;
    function stop() { stopped = true; clearInterval(timer); timer = null; }

    prev && prev.addEventListener('click', () => { stop(); go(index - 1); });
    next && next.addEventListener('click', () => { stop(); go(index + 1); });

    let raf = 0;
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    }, { passive: true });

    track.addEventListener('keydown', (e) => {
      const fwd = rtl ? 'ArrowLeft' : 'ArrowRight', back = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === fwd)  { e.preventDefault(); stop(); go(index + 1); }
      if (e.key === back) { e.preventDefault(); stop(); go(index - 1); }
    });

    // mouse drag to scroll (touch already scrolls natively)
    let down = false, startX = 0, startLeft = 0, moved = false;
    track.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      down = true; moved = false; startX = e.clientX; startLeft = track.scrollLeft;
      stop();
    });
    window.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4 && !moved) { moved = true; track.classList.add('is-dragging'); }
      if (moved) track.scrollLeft = startLeft - dx;
    });
    window.addEventListener('pointerup', () => {
      if (!down) return;
      down = false;
      if (moved) {
        track.classList.remove('is-dragging');
        go(nearest());
      }
    });

    // gentle autoplay: only while visible, stops for good once the visitor takes over
    const tick = () => {
      if (stopped || !visible || document.hidden) return;
      go(index >= cards.length - 1 ? 0 : index + 1);
    };
    const arm = () => { if (!stopped && !timer) timer = setInterval(tick, 6000); };
    ['mouseenter', 'focusin', 'touchstart', 'wheel'].forEach(ev =>
      track.addEventListener(ev, stop, { passive: true }));
    new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) arm(); },
      { threshold: 0.35 }).observe(track);

    update();
  }

  // ---------------------------------------------------------- practices explorer
  const items = [...document.querySelectorAll('.px-item')];
  if (items.length) {
    const mobile = window.matchMedia('(max-width: 860px)');
    const setActive = (target, toggle) => {
      items.forEach(item => {
        const on = item === target ? (toggle ? !item.classList.contains('is-active') : true) : false;
        item.classList.toggle('is-active', on);
        const tab = item.querySelector('.px-tab');
        tab.setAttribute('aria-selected', String(on));
        tab.setAttribute('aria-expanded', String(on));
      });
    };
    items.forEach((item, i) => {
      const tab = item.querySelector('.px-tab');
      tab.addEventListener('click', () => {
        // desktop: tabs (one always open); mobile: accordion (tap again to close)
        setActive(item, mobile.matches);
        if (mobile.matches && item.classList.contains('is-active')) {
          setTimeout(() => item.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' }), 60);
        }
      });
      tab.addEventListener('keydown', (e) => {
        if (mobile.matches) return;
        const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = items[(i + d + items.length) % items.length];
        setActive(n, false);
        n.querySelector('.px-tab').focus();
      });
    });
  }

  // ---------------------------------------------------------- timeline draw-in + reveals
  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      en.target.classList.add(en.target.classList.contains('tl-wrap') ? 'in-view' : 'in');
      io.unobserve(en.target);
    });
  }, { threshold: 0.2, rootMargin: '0px 0px -60px 0px' });

  const tl = document.querySelector('.tl-wrap');
  if (tl) { if (reducedMotion) tl.classList.add('in-view'); else io.observe(tl); }

  if (!reducedMotion) {
    document.querySelectorAll('.eng-head, .px-head, .tl-head, .tl-step, .who-item, .why2-item, .band h2')
      .forEach((el, i) => {
        el.classList.add('rv');
        el.style.transitionDelay = (el.matches('.tl-step, .who-item, .why2-item') ? (i % 4) * 0.08 : 0) + 's';
        io.observe(el);
      });
  }
});
