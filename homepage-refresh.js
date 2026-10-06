/* Progressive enhancements for the refreshed homepage. */
(() => {
  const tabList = document.querySelector('.project-tabs');
  if (tabList) {
    const tabs = [...tabList.querySelectorAll('[role="tab"]')];
    const selectTab = (selected, moveFocus = false) => {
      tabs.forEach(tab => {
        const active = tab === selected;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        panel.hidden = !active;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
      });
      if (moveFocus) selected.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(tab));
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        selectTab(tabs[next], true);
      });
    });
    tabList.hidden = false;
    selectTab(tabs[0]);
  }

  const form = document.getElementById('quoteForm');
  // Native validation must reveal an invalid optional field before focusing it.
  form?.addEventListener('invalid', event => {
    const details = event.target.closest('details');
    if (details) details.open = true;
  }, true);

  const mobileCta = document.querySelector('.mobile-quote-cta');
  if (form && mobileCta) {
    let formVisible = false;
    const updateCta = () => {
      mobileCta.hidden = formVisible || form.contains(document.activeElement)
        || document.body.classList.contains('lightbox-open');
    };
    const observer = new IntersectionObserver(entries => {
      formVisible = entries[0].isIntersecting;
      updateCta();
    });
    observer.observe(form);
    form.addEventListener('focusin', updateCta);
    form.addEventListener('focusout', () => requestAnimationFrame(updateCta));
    new MutationObserver(updateCta).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  const reviewCarousel = document.querySelector('.review-carousel');
  if (reviewCarousel) {
    const viewport = reviewCarousel.querySelector('.review-viewport');
    const track = reviewCarousel.querySelector('.review-grid');
    const controls = reviewCarousel.querySelector('.review-controls');
    const previous = controls?.querySelector('[data-review-prev]');
    const next = controls?.querySelector('[data-review-next]');
    const toggle = controls?.querySelector('[data-review-toggle]');
    const position = controls?.querySelector('.review-position');
    const reviews = track ? [...track.querySelectorAll('.review')] : [];

    // Without a complete carousel, keep every review readable as ordinary content.
    if (viewport && track && controls && previous && next && toggle && position && reviews.length > 1) {
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      let index = 0;
      let playbackChoice = null;
      let inView = false;
      let hovering = viewport.matches(':hover');
      let touching = false;
      let swipeStart = null;
      let timer;
      const wantsPlayback = () => playbackChoice ?? !motion.matches;
      const renderToggle = () => {
        const playing = wantsPlayback();
        const text = toggle.querySelector('.review-toggle-text');
        const icon = toggle.querySelector('.review-toggle-icon');
        if (text) text.textContent = playing ? 'Szünet' : 'Lejátszás';
        if (icon) icon.textContent = playing ? 'Ⅱ' : '▶';
        toggle.setAttribute('aria-label', playing
          ? 'Vélemények automatikus váltásának szüneteltetése'
          : 'Vélemények automatikus váltásának indítása');
      };
      const renderReview = () => {
        track.style.transform = `translateX(-${index * 100}%)`;
        reviews.forEach((review, reviewIndex) => {
          const inactive = reviewIndex !== index;
          review.setAttribute('aria-hidden', String(inactive));
          review.inert = inactive;
        });
        position.textContent = `${index + 1} / ${reviews.length}`;
      };
      const schedule = () => {
        clearTimeout(timer);
        if (!wantsPlayback() || !inView || document.hidden || hovering || touching
            || reviewCarousel.contains(document.activeElement)) return;
        timer = setTimeout(() => {
          index = (index + 1) % reviews.length;
          renderReview();
          schedule();
        }, 6500);
      };
      const move = direction => {
        index = (index + direction + reviews.length) % reviews.length;
        renderReview();
        schedule();
      };

      previous.addEventListener('click', () => move(-1));
      next.addEventListener('click', () => move(1));
      toggle.addEventListener('click', () => {
        playbackChoice = !wantsPlayback();
        renderToggle();
        schedule();
      });
      controls.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        move(event.key === 'ArrowRight' ? 1 : -1);
      });
      viewport.addEventListener('mouseenter', () => { hovering = true; schedule(); });
      viewport.addEventListener('mouseleave', () => { hovering = false; schedule(); });
      reviewCarousel.addEventListener('focusin', schedule);
      reviewCarousel.addEventListener('focusout', () => requestAnimationFrame(schedule));
      document.addEventListener('visibilitychange', schedule);
      motion.addEventListener('change', () => { renderToggle(); schedule(); });

      viewport.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch' || !event.isPrimary) return;
        touching = true;
        swipeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        viewport.setPointerCapture?.(event.pointerId);
        schedule();
      }, { passive: true });
      viewport.addEventListener('pointerup', event => {
        if (!swipeStart || event.pointerId !== swipeStart.pointerId) return;
        const deltaX = event.clientX - swipeStart.x;
        const deltaY = event.clientY - swipeStart.y;
        swipeStart = null;
        touching = false;
        if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
          move(deltaX < 0 ? 1 : -1);
        } else schedule();
      }, { passive: true });
      viewport.addEventListener('pointercancel', () => {
        swipeStart = null;
        touching = false;
        schedule();
      }, { passive: true });

      if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver(entries => {
          inView = entries.some(entry => entry.target === viewport && entry.isIntersecting);
          schedule();
        });
        observer.observe(viewport);
      } else {
        const updateVisibility = () => {
          const rect = viewport.getBoundingClientRect();
          inView = rect.bottom > 0 && rect.top < window.innerHeight
            && rect.right > 0 && rect.left < window.innerWidth;
          schedule();
        };
        window.addEventListener('scroll', updateVisibility, { passive: true });
        window.addEventListener('resize', updateVisibility, { passive: true });
        updateVisibility();
      }

      renderReview();
      renderToggle();
      reviewCarousel.classList.add('is-enhanced');
      controls.hidden = false;
      schedule();
    }
  }
})();
