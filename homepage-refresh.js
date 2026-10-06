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
})();
