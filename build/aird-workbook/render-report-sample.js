// Smoke test: render a sample personalised report to /tmp using the local
// (build-time) Puppeteer. Useful for previewing the report template without
// going through Cloud Functions.

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const { buildReportHtml, reportPageHeaderFooter } = require('../../functions/src/lib/report');

const SAMPLE = {
    organisation: 'The Sample Theatre',
    role: 'Executive Director',
    country: 'Ireland',
    sector: 'theatre',
    scores: { q1: 2, q2: 3, q3: 2, q4: 1, q5: 3, q6: 2, q7: 2, q8: 3 },
};

const sum = Object.values(SAMPLE.scores).reduce((a, b) => a + b, 0);
SAMPLE.overallScore = sum / 8;
SAMPLE.band = SAMPLE.overallScore < 2.5 ? 'control' : SAMPLE.overallScore < 3.5 ? 'structure' : 'improvement';

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const html = buildReportHtml(SAMPLE);
        const { header, footer } = reportPageHeaderFooter(SAMPLE.organisation);
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const out = '/tmp/aird-report-sample.pdf';
        await page.pdf({
            path: out,
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: header,
            footerTemplate: footer,
            margin: { top: '24mm', right: '18mm', bottom: '22mm', left: '25mm' },
        });
        console.log('Wrote', out, '-', (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
        console.log('Overall:', SAMPLE.overallScore.toFixed(2), 'Band:', SAMPLE.band);
    } finally {
        await browser.close();
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
