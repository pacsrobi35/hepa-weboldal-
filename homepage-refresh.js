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
      const narrowBook = window.matchMedia('(max-width: 640px)');
      let index = 0;
      let playbackChoice = null;
      let inView = false;
      let hovering = viewport.matches(':hover');
      let touching = false;
      let swipeStart = null;
      let timer;
      let turn = null;
      let queuedDirection = null;
      const wantsPlayback = () => playbackChoice ?? !motion.matches;
      const pageCount = () => narrowBook.matches ? 1 : 2;
      const spreadAt = start => Array.from({ length: pageCount() }, (_, offset) => (start + offset) % reviews.length);
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
      const cloneReview = review => {
        const clone = review.cloneNode(true);
        clone.removeAttribute('id');
        clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        clone.classList.remove('is-left', 'is-right');
        clone.style.removeProperty('order');
        clone.hidden = false;
        clone.setAttribute('aria-hidden', 'true');
        clone.inert = true;
        return clone;
      };
      const sizePages = () => {
        const width = viewport.clientWidth / pageCount();
        if (!width) return;
        track.style.removeProperty('min-height');
        let height = parseFloat(getComputedStyle(track).minHeight) || 0;
        // Size the paper for the longest existing quote at this breakpoint.
        // Measurement copies never become visible or accessible.
        reviews.forEach(review => {
          const copy = cloneReview(review);
          Object.assign(copy.style, {
            position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
            width: `${width}px`, height: 'auto', top: '0', left: '0'
          });
          viewport.appendChild(copy);
          height = Math.max(height, copy.getBoundingClientRect().height);
          copy.remove();
        });
        track.style.minHeight = `${Math.ceil(height)}px`;
      };
      const renderPages = pages => {
        track.querySelectorAll('[data-book-temporary]').forEach(element => element.remove());
        track.style.removeProperty('transform');
        reviews.forEach(review => {
          review.hidden = true;
          review.setAttribute('aria-hidden', 'true');
          review.inert = true;
          review.classList.remove('is-left', 'is-right');
          review.style.removeProperty('order');
        });
        const used = new Set();
        pages.forEach((reviewIndex, slot) => {
          let page = reviews[reviewIndex];
          if (used.has(reviewIndex)) {
            // With two quotes, the old left and incoming right page coincide.
            // This visual-only copy exists solely underneath the turning leaf.
            page = cloneReview(page);
            page.setAttribute('data-book-temporary', '');
            track.appendChild(page);
          } else {
            page.hidden = false;
            page.setAttribute('aria-hidden', 'false');
            page.inert = false;
          }
          used.add(reviewIndex);
          page.classList.add(slot === 0 ? 'is-left' : 'is-right');
          page.style.order = String(slot);
        });
      };
      const renderSpread = () => {
        const pages = spreadAt(index);
        renderPages(pages);
        const label = pages.length === 2 && reviews.length === 2
          ? '1–2' : pages.map(pageIndex => pageIndex + 1).join('–');
        position.textContent = `${label} / ${reviews.length}`;
      };
      const schedule = () => {
        clearTimeout(timer);
        if (!wantsPlayback() || !inView || document.hidden || hovering || touching || turn
            || reviewCarousel.contains(document.activeElement)) return;
        timer = setTimeout(() => move(1), 8000);
      };
      const finishTurn = (continueQueued = true) => {
        if (!turn) return;
        clearTimeout(turn.timeout);
        cancelAnimationFrame(turn.frame);
        index = turn.targetIndex;
        turn.leaf.remove();
        turn = null;
        viewport.classList.remove('is-book-turning');
        renderSpread();
        const direction = queuedDirection;
        queuedDirection = null;
        if (continueQueued && direction !== null) move(direction);
        else schedule();
      };
      const move = direction => {
        clearTimeout(timer);
        if (turn) {
          // Keep only the latest extra press instead of stacking animated leaves.
          queuedDirection = direction;
          return;
        }
        const step = !narrowBook.matches && reviews.length > 2 ? 2 : 1;
        const targetIndex = (index + direction * step + reviews.length) % reviews.length;
        if (motion.matches) {
          index = targetIndex;
          renderSpread();
          schedule();
          return;
        }
        const oldPages = spreadAt(index);
        const newPages = spreadAt(targetIndex);
        const forward = direction > 0;
        const frontIndex = narrowBook.matches ? oldPages[0] : oldPages[forward ? 1 : 0];
        const backIndex = narrowBook.matches ? newPages[0] : newPages[forward ? 0 : 1];
        const leaf = document.createElement('div');
        leaf.className = 'book-leaf ' + (forward ? 'is-next' : 'is-prev');
        leaf.setAttribute('aria-hidden', 'true');
        leaf.inert = true;
        for (const [face, reviewIndex] of [['front', frontIndex], ['back', backIndex]]) {
          const side = document.createElement('div');
          side.className = 'book-leaf-' + face;
          const copy = cloneReview(reviews[reviewIndex]);
          const rightPage = !narrowBook.matches && (forward ? face === 'front' : face === 'back');
          copy.classList.add(rightPage ? 'is-right' : 'is-left');
          side.appendChild(copy);
          leaf.appendChild(side);
        }
        renderPages(narrowBook.matches ? newPages
          : forward ? [oldPages[0], newPages[1]] : [newPages[0], oldPages[1]]);
        viewport.appendChild(leaf);
        viewport.classList.add('is-book-turning');
        const currentTurn = { targetIndex, leaf, frame: null, timeout: null };
        turn = currentTurn;
        const complete = event => {
          if (turn !== currentTurn) return;
          if (event && event.target !== leaf) return;
          if (event?.type === 'transitionend' && event.propertyName !== 'transform') return;
          finishTurn();
        };
        leaf.addEventListener('transitionend', complete);
        leaf.addEventListener('animationend', complete);
        // Flush the initial paper position before CSS starts the 3D turn.
        leaf.getBoundingClientRect();
        currentTurn.frame = requestAnimationFrame(() => {
          if (turn === currentTurn) leaf.classList.add('is-turning');
        });
        currentTurn.timeout = setTimeout(() => complete(), 950);
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
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) finishTurn(false);
        schedule();
      });
      motion.addEventListener('change', () => {
        if (motion.matches) finishTurn(false);
        renderToggle();
        schedule();
      });
      const resizeBook = () => {
        finishTurn(false);
        sizePages();
        renderSpread();
        schedule();
      };
      narrowBook.addEventListener('change', resizeBook);
      window.addEventListener('resize', resizeBook, { passive: true });

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
          if (!inView) finishTurn(false);
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

      sizePages();
      renderSpread();
      renderToggle();
      reviewCarousel.classList.add('is-enhanced');
      controls.hidden = false;
      schedule();
    }
  }
})();
