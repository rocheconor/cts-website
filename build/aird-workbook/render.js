// Render the AIRD workbook template to /aireadiness/AI-readiness-workbook.pdf
// using Puppeteer. Run: node build/aird-workbook/render.js

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(__dirname, 'template.html');
const OUTPUT = path.join(ROOT, 'aireadiness', 'AI-readiness-workbook.pdf');
const FN_ASSET = path.join(ROOT, 'functions', 'assets', 'AI-readiness-workbook.pdf');

const dateStr = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

// Note: Puppeteer's headerTemplate/footerTemplate reserves the class names
// "date", "title", "url", "pageNumber", "totalPages" — these get auto-replaced
// with browser-supplied values. Avoid using them for your own content.
const HEADER_HTML = `
<style>
  .hf { width:100%; font-family: 'Helvetica', 'Arial', sans-serif; font-size: 8pt; color: #1a1a1a; padding: 0 18mm 0 25mm; }
  .hf .row { display: flex; justify-content: space-between; align-items: flex-start; }
  .hf .b-name { font-weight: 600; }
  .hf .b-url { color: #555; font-size: 7.5pt; }
  .hf .doc-date { font-weight: 500; }
</style>
<div class="hf">
  <div class="row">
    <div>
      <div class="b-name">Creative Thinking Systems</div>
      <div class="b-url">creativethinkingsystems.com</div>
    </div>
    <div class="doc-date">${dateStr}</div>
  </div>
</div>
`;

const FOOTER_HTML = `
<style>
  .hf { width:100%; font-family: 'Helvetica', 'Arial', sans-serif; font-size: 7.5pt; color: #1a1a1a; padding: 0 18mm 0 25mm; }
  .hf .row { display: flex; justify-content: space-between; padding-top: 3mm; border-top: 0.6pt solid #1a1a1a; }
  .hf .left { font-weight: 500; }
  .hf .sep { color: #999; padding: 0 2mm; }
  .hf .b-url { color: #555; }
  .hf .pg { color: #1a1a1a; }
</style>
<div class="hf">
  <div class="row">
    <div class="left">Creative Thinking Systems <span class="sep">·</span> <span class="b-url">creativethinkingsystems.com</span></div>
    <div class="pg">AI Readiness Workbook <span class="sep">·</span> <span class="pageNumber"></span></div>
  </div>
</div>
`;

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const html = fs.readFileSync(TEMPLATE, 'utf8');
        await page.setContent(html, { waitUntil: 'networkidle0' });

        await page.pdf({
            path: OUTPUT,
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: HEADER_HTML,
            footerTemplate: FOOTER_HTML,
            margin: { top: '24mm', right: '18mm', bottom: '22mm', left: '25mm' },
            // Suppress header/footer on cover (page 1) via a CSS class set by header content
            pageRanges: '',
        });

        console.log('Wrote', OUTPUT);
        const stats = fs.statSync(OUTPUT);
        console.log('Size:', (stats.size / 1024).toFixed(0) + ' KB');

        // Mirror into functions/ so the Cloud Function can attach it.
        if (fs.existsSync(path.dirname(FN_ASSET))) {
            fs.copyFileSync(OUTPUT, FN_ASSET);
            console.log('Copied to', FN_ASSET);
        }
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error('Render failed:', err);
    process.exit(1);
});
