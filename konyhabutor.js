(() => {
    "use strict";
    const dialog = document.getElementById("photo-dialog");
    if (!dialog || typeof dialog.showModal !== "function") return;
    const image = dialog.querySelector("img");
    const caption = dialog.querySelector(".photo-caption");
    let opener = null;

    document.querySelectorAll("a[data-photo]").forEach(link => {
        link.addEventListener("click", event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const preview = link.querySelector("img");
            if (!preview) return;
            event.preventDefault();
            opener = link;
            image.src = link.href;
            image.alt = preview.alt;
            caption.textContent = preview.alt;
            dialog.showModal();
        });
    });
    dialog.querySelector(".photo-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    dialog.addEventListener("close", () => {
        image.removeAttribute("src");
        image.alt = "";
        opener?.focus({ preventScroll: true });
    });
})();
