// Heirstone Consulting - Main JS

document.addEventListener('DOMContentLoaded', () => {

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Hamburger toggle
  const hamburger = document.querySelector('.hamburger');
  const mobileNav = document.querySelector('.mobile-nav');

  if (hamburger && mobileNav) {
    const setOpen = (open) => {
      mobileNav.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', String(open));
      hamburger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };

    hamburger.addEventListener('click', () => {
      setOpen(!mobileNav.classList.contains('open'));
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!hamburger.contains(e.target) && !mobileNav.contains(e.target)) {
        setOpen(false);
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobileNav.classList.contains('open')) {
        setOpen(false);
        hamburger.focus();
      }
    });
  }

  // Navbar scroll effect
  const navbar = document.querySelector('.navbar');
  if (navbar) {
    window.addEventListener('scroll', () => {
      navbar.style.background = window.scrollY > 20
        ? 'rgba(13, 27, 42, 0.99)'
        : 'rgba(13, 27, 42, 0.97)';
    }, { passive: true });
  }

  // Active nav link (compare resolved pathnames so relative prefixes don't matter)
  const currentFile = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  document.querySelectorAll('.navbar-nav a, .mobile-nav a, .dropdown-menu a').forEach(link => {
    if (link.classList.contains('navbar-cta')) return;
    const linkFile = (new URL(link.href, window.location.href).pathname.split('/').pop() || 'index.html').toLowerCase();
    if (linkFile === currentFile) {
      link.classList.add('active');
    }
  });

  // Hero slideshow (fading)
  const slides = document.querySelectorAll('.hero-slide');
  if (slides.length > 1 && !reducedMotion) {
    let current = 0;
    setInterval(() => {
      if (document.hidden) return;
      slides[current].classList.remove('active');
      current = (current + 1) % slides.length;
      slides[current].classList.add('active');
    }, 6000);
  }

  // Contact form submit (FormSubmit AJAX endpoint)
  const form = document.querySelector('.contact-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const btn = form.querySelector('button[type="submit"]');
      const status = form.querySelector('.form-status');
      const setStatus = (msg, kind) => {
        if (!status) return;
        status.innerHTML = msg;
        status.classList.remove('success', 'error');
        if (kind) status.classList.add(kind);
      };

      // Native validation with visible feedback
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      setStatus('', null);

      const data = Object.fromEntries(new FormData(form).entries());
      if (!data._subject) data._subject = 'Website enquiry — heirstoneconsulting.com';
      data._template = 'table';

      try {
        const res = await fetch('https://formsubmit.co/ajax/info@heirstoneconsulting.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('Request failed: ' + res.status);
        await res.json();
        form.reset();
        btn.textContent = 'Message Sent';
        setStatus('Thank you — your message has been sent. We typically respond within one business day.', 'success');
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 4000);
      } catch (err) {
        btn.textContent = original;
        btn.disabled = false;
        setStatus('Something went wrong and your message was not sent. Please email us directly at <a href="mailto:info@heirstoneconsulting.com">info@heirstoneconsulting.com</a>.', 'error');
      }
    });
  }

  // Smooth scroll for same-page anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      const href = anchor.getAttribute('href');
      if (!href || href === '#') return;
      let target = null;
      try { target = document.querySelector(href); } catch (err) { return; }
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      }
    });
  });

  // Intersection Observer for fade-in animations
  if (!reducedMotion) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    document.querySelectorAll('.method-card, .sector-card, .why-item, .serve-item, .exp-card, .approach-step, .service-tag').forEach(el => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(20px)';
      el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
      observer.observe(el);
    });
  }

});
