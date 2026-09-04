const fs = require('fs');
const path = require('path');

const root = process.cwd();
const source = path.join(root, 'index.html');
const dist = path.join(root, 'dist');

let html = fs.readFileSync(source, 'utf8');

const oldBase = `.type {\n    background: white;\n    padding: 45px 30px;\n    text-align: center;\n    border: 1px solid #e3ddd3;\n    transition: 0.3s;\n}\n\n.type:hover {\n    transform: translateY(-8px);\n    box-shadow: 0 15px 35px rgba(0, 0, 0, 0.08);\n}\n        /* BÚTOR KATEGÓRIÁK - KÉPES HÁTTÉR */\n\n.type {\n    position: relative;\n    overflow: hidden;\n    min-height: 270px;\n\n    background-size: cover !important;\n    background-position: center !important;\n    background-repeat: no-repeat !important;\n\n    display: flex;\n    flex-direction: column;\n    justify-content: center;\n    align-items: center;\n}\n\n/* Sötét réteg a kép fölé */\n\n.type::before {\n    content: \"\";\n    position: absolute;\n    inset: 0;\n    background: rgba(0, 0, 0, 0.45);\n    transition: background 0.3s ease;\n}\n\n/* A szöveg legyen a sötét réteg fölött */\n\n.type h3,\n.type p {\n    position: relative;\n    z-index: 1;\n    color: white;\n    text-align: center;\n}\n`;

const newBase = `/* BÚTOR KATEGÓRIÁK - KÉPES HÁTTÉR */\n\n.type {\n    position: relative;\n    overflow: hidden;\n    min-height: 270px;\n    padding: 35px 30px;\n    border: 0;\n    border-radius: 14px;\n    text-align: center;\n    background-size: cover !important;\n    background-position: center !important;\n    background-repeat: no-repeat !important;\n    display: flex;\n    flex-direction: column;\n    justify-content: center;\n    align-items: center;\n    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);\n    transition: transform 0.3s ease, box-shadow 0.3s ease;\n}\n\n/* Világos, csak enyhén sötétítő réteg */\n.type::before {\n    content: \"\";\n    position: absolute;\n    inset: 0;\n    background: linear-gradient(\n        to bottom,\n        rgba(0, 0, 0, 0.04),\n        rgba(0, 0, 0, 0.28)\n    );\n    transition: background 0.3s ease;\n}\n\n/* A szöveg mindig a kép fölött marad */\n.type h3,\n.type p {\n    position: relative;\n    z-index: 1;\n    text-align: center;\n    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.65);\n}\n`;

if (!html.includes(oldBase)) throw new Error('Furniture card base CSS not found');
html = html.replace(oldBase, newBase);

const oldHover = `.type:hover {\n    transform: translateY(-8px);\n}\n\n.type:hover::before {\n    background: rgba(0, 0, 0, 0.25);\n}\n\n.type-icon {\n    font-size: 38px;\n    margin-bottom: 20px;\n}\n\n.type h3 {\n    font-size: 24px;\n    color: #b7832f;\n    margin-bottom: 15px;\n}\n\n.type p {\n    color: #666;\n    line-height: 1.7;\n}\n`;

const newHover = `.type:hover {\n    transform: translateY(-7px);\n    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.18);\n}\n\n.type:hover::before {\n    background: linear-gradient(\n        to bottom,\n        rgba(0, 0, 0, 0.01),\n        rgba(0, 0, 0, 0.16)\n    );\n}\n\n/* Nincs ikon a kategóriakártyákon */\n\n.type h3 {\n    font-size: 27px;\n    color: #e1ad58;\n    margin-bottom: 10px;\n    letter-spacing: 0.2px;\n}\n\n.type p {\n    color: #ffffff;\n    line-height: 1.6;\n    font-size: 15px;\n    max-width: 280px;\n}\n`;

if (!html.includes(oldHover)) throw new Error('Furniture card hover/icon CSS not found');
html = html.replace(oldHover, newHover);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html, 'utf8');

for (const entry of fs.readdirSync(root)) {
    if (['.git', '.github', 'dist', 'patch.js', 'vercel.json', 'node_modules'].includes(entry)) continue;
    const src = path.join(root, entry);
    const dst = path.join(dist, entry);
    fs.cpSync(src, dst, { recursive: true });
}

console.log('HEPA furniture cards patched successfully.');