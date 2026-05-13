// Render an HTML string to a PDF Buffer.
// Uses puppeteer-core + @sparticuz/chromium so the function bundle stays
// small enough for Cloud Functions.

const path = require('path');
const fs = require('fs');

let _browser = null;

async function getBrowser() {
    if (_browser) return _browser;
    const puppeteer = require('puppeteer-core');
    const chromium = require('@sparticuz/chromium');
    _browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
    });
    return _browser;
}

async function renderHtmlToPdf(html, { headerTemplate, footerTemplate, margin } = {}) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'networkidle0' });
        return await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: !!(headerTemplate || footerTemplate),
            headerTemplate: headerTemplate || '<div></div>',
            footerTemplate: footerTemplate || '<div></div>',
            margin: margin || { top: '24mm', right: '18mm', bottom: '22mm', left: '25mm' },
        });
    } finally {
        await page.close();
    }
}

function readTemplate(name) {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'templates', name), 'utf8');
}

module.exports = { renderHtmlToPdf, readTemplate };
