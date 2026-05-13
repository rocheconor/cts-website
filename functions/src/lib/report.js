// Builds the HTML for the personalised AIRD report.
// Three band-specific 30/60/90 templates and three band interpretations
// match the workbook copy exactly (sector-agnostic).

const QUESTIONS = [
    { id: 'q1', area: 'Leadership and governance' },
    { id: 'q2', area: 'Data protection and confidentiality' },
    { id: 'q3', area: 'Cybersecurity, fraud and supplier risk' },
    { id: 'q4', area: 'Approved tools and access' },
    { id: 'q5', area: 'Staff use, skills and confidence' },
    { id: 'q6', area: 'Workflow and productivity opportunities' },
    { id: 'q7', area: 'Knowledge, archive and reusable assets' },
    { id: 'q8', area: 'Creative rights, IP and accountability' },
];

const BAND_DEFS = {
    control: {
        label: 'Priority: Control',
        interp: `<strong>Mostly 1s and 2s.</strong> Your organisation has unmanaged exposure to AI. The priority is <strong>control</strong>: map current use, issue interim guidance, identify approved tools, review data and confidentiality risks, and add AI to the risk register.`,
    },
    structure: {
        label: 'Priority: Structure',
        interp: `<strong>Mostly 3s.</strong> Your organisation has started to respond. The priority is <strong>structure</strong>: map workflows, train staff, select pilot use cases, define review and approval processes, and report progress to leadership and the board.`,
    },
    improvement: {
        label: 'Priority: Improvement',
        interp: `<strong>Mostly 4s and 5s.</strong> Your organisation is ready to scale adoption. The priority is <strong>improvement</strong>: measure benefits, refine governance, expand safe use cases, improve knowledge management, and embed AI into priority workflows.`,
    },
};

// The full 30/60/90 plan with band-specific emphasis. The actions are the
// same across bands; the surrounding framing changes.
const NEXT_STEPS = {
    control: {
        intro: 'Your priority is control. Start by understanding where AI is already in use, set proportionate guardrails, and get AI on the risk register. The plan below sequences the work.',
        emphasis: ['First 30 days'],
    },
    structure: {
        intro: 'Your priority is structure. You have started to respond; now the work is to formalise ownership, define approval routes, pick pilot use cases, and build internal capability. The plan below sequences the work.',
        emphasis: ['Days 30 to 60'],
    },
    improvement: {
        intro: 'Your priority is improvement. With managed adoption in place, the work is to measure benefits, expand safe use, and embed AI into priority workflows. The plan below sequences the work.',
        emphasis: ['Days 60 to 90'],
    },
};

const PLAN = [
    {
        head: 'First 30 days', label: 'Establish control',
        actions: [
            'Map current AI use across staff and partners.',
            'Identify high-risk information, including audience, donor, HR, artist, contract, board and financial data.',
            'Identify any immediate GDPR, confidentiality or cyber concerns.',
            'Add AI to the organisational risk register.',
            'Define approved and non-approved tools.',
            'Issue interim AI usage guidance.',
        ],
        output: 'Current exposure map and interim AI guidance.',
    },
    {
        head: 'Days 30 to 60', label: 'Identify value',
        actions: [
            'Map recurring workflows across operations, fundraising, marketing, programming and governance.',
            'Identify three to five low-risk, high-utility pilot use cases.',
            'Agree approval rules for public-facing AI-assisted material.',
            'Identify training needs for staff and managers.',
        ],
        output: 'Prioritised AI opportunity map and pilot plan.',
    },
    {
        head: 'Days 60 to 90', label: 'Pilot and measure',
        actions: [
            'Train pilot users and agree use-case owners.',
            'Test AI in selected workflows.',
            'Track time saved, quality improved and risks identified.',
            'Review staff confidence and adoption.',
            'Capture lessons and refine guidance.',
            'Report findings to the executive team and board.',
            'Decide whether to scale, pause or redesign each pilot.',
        ],
        output: 'AI readiness update report and next-stage adoption plan.',
    },
];

const SUCCESS = [
    { head: 'Administration.', body: 'AI reduces repetitive drafting, formatting, summarising and coordination work. First drafts of reports, briefings, policies and funding materials are produced faster, drawing more effectively on existing knowledge and data. Meeting notes, actions and summaries become easier to produce and share. Teams reduce duplication across departments.' },
    { head: 'Risk and governance.', body: 'Your organisation knows where AI is being used and applies proportionate controls. AI appears on the organisational risk register. Staff understand what data must not be entered into AI tools. Approved tools and prohibited uses are clearly defined. Supplier AI features are reviewed. Public-facing AI-assisted content is checked before release.' },
    { head: 'Operations and delivery.', body: 'AI supports planning, documentation, handovers and reporting. Operational teams spend less time creating and reworking routine documentation. Risk assessments, access notes and technical checklists become more consistent. Project reports and post-event learning are easier to capture and share.' },
    { head: 'Fundraising and development.', body: 'AI supports research, drafting, stakeholder mapping and impact reporting. Donor, trust and stakeholder research becomes faster. Funding applications and impact reports move from blank page to review draft more quickly. Funder-facing claims remain accurate, evidenced and human-reviewed.' },
    { head: 'Marketing and audience development.', body: 'AI supports campaign development, audience insight, accessibility and communication. Marketing teams create more campaign variants without losing their organisation’s voice. Audience feedback and survey data are analysed more consistently. Accessibility, plain-English and multilingual materials become easier to produce.' },
    { head: 'People and creative judgement.', body: 'AI supports staff, artists and leadership without replacing judgement. Staff understand when to use AI and when not to. Final decisions remain with accountable people. Artistic, contractual, safeguarding and reputational decisions stay human-led. Artists and creative teams understand how AI may or may not be used in their work.' },
    { head: 'Knowledge and archive.', body: 'Your organisation makes better use of its existing knowledge, archive and institutional memory. Teams can draw on previous reports, templates, policies and project records more easily. New staff and partners can access clearer onboarding and background material. Past projects, audience insights and funding materials inform future work.' },
];

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function dateString() {
    return new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function bandFor(avg) {
    if (avg < 2.5) return 'control';
    if (avg < 3.5) return 'structure';
    return 'improvement';
}

function buildReportHtml({ organisation, role, country, sector, scores, overallScore, band }) {
    const safeOrg = escapeHtml(organisation && organisation.trim() ? organisation.trim() : 'your organisation');
    const dateStr = dateString();
    const resolvedBand = band || bandFor(overallScore);
    const bd = BAND_DEFS[resolvedBand];
    const next = NEXT_STEPS[resolvedBand];

    // Build score breakdown rows
    const rows = QUESTIONS.map((q, i) => {
        const score = scores[q.id] || 0;
        let dots = '';
        for (let d = 1; d <= 5; d++) {
            dots += `<span class="bd-dot${d <= score ? ' on' : ''}"></span>`;
        }
        return `
            <tr>
                <td class="num">0${i + 1}</td>
                <td class="area">${escapeHtml(q.area)}</td>
                <td class="bar"><div class="dots">${dots}</div></td>
                <td class="score">${score} / 5</td>
            </tr>`;
    }).join('');

    // Plan blocks with emphasis on band-specific phase
    const planBlocks = PLAN.map((p) => {
        const emph = next.emphasis.includes(p.head) ? ' plan--emph' : '';
        const actions = p.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('');
        return `
            <div class="plan${emph}">
                <div class="plan__head">${escapeHtml(p.head)} <span class="plan__lab">: ${escapeHtml(p.label)}</span></div>
                <div class="plan__alabel">Actions</div>
                <ul>${actions}</ul>
                <div class="plan__out"><strong>Output:</strong> ${escapeHtml(p.output)}</div>
            </div>`;
    }).join('');

    const successBlocks = SUCCESS.map((s) => `
        <div class="success">
            <div class="success__head">${escapeHtml(s.head)}</div>
            <p class="success__body">${escapeHtml(s.body)}</p>
        </div>
    `).join('');

    const css = `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { font-family: 'Inter', sans-serif; color: #1a1a1a; background: #fff; font-size: 10.5pt; line-height: 1.55; }
        .cover { padding-top: 60mm; padding-bottom: 30mm; }
        .cover__label { font-family: 'Space Grotesk', sans-serif; font-size: 9pt; font-weight: 500; letter-spacing: 0.22em; text-transform: uppercase; margin-bottom: 12mm; }
        .cover__title { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 36pt; line-height: 1.02; letter-spacing: -0.03em; margin-bottom: 12mm; max-width: 18em; }
        .cover__forline { font-family: 'Instrument Serif', serif; font-style: italic; font-size: 18pt; line-height: 1.35; color: #444; max-width: 32em; padding-left: 5mm; border-left: 1.5pt solid #1a1a1a; margin-bottom: 12mm; }
        .cover__meta { font-family: 'Space Grotesk', sans-serif; font-size: 9.5pt; color: #555; line-height: 1.8; }
        .cover__meta b { color: #1a1a1a; font-weight: 500; }
        .section { page-break-before: always; padding-top: 4mm; }
        .section__head { display: grid; grid-template-columns: 12mm 1fr; gap: 4mm; align-items: baseline; border-top: 0.6pt solid #1a1a1a; padding-top: 4mm; margin-bottom: 10mm; }
        .section__num { font-family: 'Space Grotesk', sans-serif; font-size: 8.5pt; font-weight: 500; letter-spacing: 0.12em; color: #999; padding-top: 3mm; }
        .section__title { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 20pt; line-height: 1.1; letter-spacing: -0.02em; }
        h3 { font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 12pt; margin-top: 7mm; margin-bottom: 3mm; }
        p { margin-bottom: 3mm; }
        strong { font-weight: 600; }

        .overall { display: grid; grid-template-columns: auto 1fr; gap: 8mm; align-items: center; margin-bottom: 6mm; padding-bottom: 6mm; border-bottom: 0.6pt solid #e6e4de; }
        .overall__score { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 48pt; line-height: 1; letter-spacing: -0.04em; }
        .overall__score small { font-size: 0.4em; color: #999; font-weight: 400; letter-spacing: 0; }
        .overall__band { font-family: 'Space Grotesk', sans-serif; font-size: 8pt; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: #555; margin-bottom: 2mm; }
        .overall__priority { font-family: 'Instrument Serif', serif; font-style: italic; font-size: 14pt; line-height: 1.35; color: #1a1a1a; }
        .overall__priority strong { font-weight: 400; text-decoration: underline; text-underline-offset: 0.18em; }

        table.bd { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 9.5pt; }
        table.bd td { padding: 2mm 0; border-bottom: 0.4pt solid #e6e4de; vertical-align: middle; }
        table.bd td.num { width: 10mm; font-family: 'Space Grotesk', sans-serif; font-size: 8pt; color: #999; letter-spacing: 0.06em; }
        table.bd td.area { font-weight: 500; }
        table.bd td.bar { width: 36mm; padding-right: 4mm; }
        table.bd td.score { width: 16mm; text-align: right; font-family: 'Space Grotesk', sans-serif; font-weight: 600; color: #1a1a1a; }
        .dots { display: inline-flex; gap: 1.5mm; }
        .bd-dot { width: 3mm; height: 3mm; border-radius: 50%; background: #e6e4de; display: inline-block; }
        .bd-dot.on { background: #1a1a1a; }

        .interpret { background: #f5f4f0; border-radius: 2mm; padding: 6mm 7mm; margin: 4mm 0; }
        .interpret p { color: #1a1a1a; line-height: 1.65; }

        .plan { border-top: 0.6pt solid #1a1a1a; padding-top: 4mm; margin-top: 5mm; page-break-inside: avoid; }
        .plan__head { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 12pt; margin-bottom: 2mm; letter-spacing: -0.01em; }
        .plan__lab { color: #999; font-weight: 500; }
        .plan__alabel { font-family: 'Space Grotesk', sans-serif; font-size: 7.5pt; font-weight: 500; letter-spacing: 0.16em; color: #999; text-transform: uppercase; margin-top: 2.5mm; margin-bottom: 1mm; }
        .plan ul { margin-left: 4mm; font-size: 9.5pt; line-height: 1.55; }
        .plan ul li { margin-bottom: 0.5mm; }
        .plan__out { margin-top: 2.5mm; font-size: 9pt; color: #444; border-left: 1pt solid #999; padding-left: 3mm; }
        .plan--emph { border-top-width: 1.5pt; }
        .plan--emph .plan__head { color: #1a1a1a; }
        .plan--emph::before { content: 'YOUR PRIORITY'; display: inline-block; font-family: 'Space Grotesk', sans-serif; font-size: 7pt; font-weight: 600; letter-spacing: 0.2em; color: #fff; background: #1a1a1a; padding: 1mm 2.5mm; margin-bottom: 3mm; border-radius: 1mm; }

        .success { page-break-inside: avoid; margin-bottom: 5mm; }
        .success__head { font-family: 'Space Grotesk', sans-serif; font-weight: 600; font-size: 10.5pt; margin-bottom: 1.5mm; }
        .success__body { font-size: 9.5pt; color: #1a1a1a; line-height: 1.5; }

        .about { font-size: 10pt; line-height: 1.6; }
        .about__contact { margin-top: 5mm; font-family: 'Space Grotesk', sans-serif; font-size: 10pt; font-weight: 500; }
    `;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AI Readiness Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>

<section class="cover">
    <p class="cover__label">AI Readiness Report</p>
    <h1 class="cover__title">AI Readiness for ${safeOrg}</h1>
    <p class="cover__forline">A personalised diagnostic. Your scores across eight areas, what they mean, and a tailored 30/60/90 plan.</p>
    <div class="cover__meta">
        <div><b>Overall score:</b> ${overallScore.toFixed(1)} / 5</div>
        <div><b>${bd.label}</b></div>
        <div>Prepared: ${dateStr}</div>
    </div>
</section>

<section class="section">
    <header class="section__head">
        <span class="section__num">01</span>
        <h2 class="section__title">Your score</h2>
    </header>
    <div class="overall">
        <div>
            <div class="overall__score">${overallScore.toFixed(1)}<small> / 5</small></div>
        </div>
        <div>
            <div class="overall__band">${bd.label}</div>
            <p class="overall__priority">Your priority is <strong>${escapeHtml(resolvedBand)}</strong>.</p>
        </div>
    </div>

    <h3>Area by area</h3>
    <table class="bd">
        <tbody>${rows}</tbody>
    </table>
</section>

<section class="section">
    <header class="section__head">
        <span class="section__num">02</span>
        <h2 class="section__title">What this means</h2>
    </header>
    <div class="interpret">
        <p>${bd.interp}</p>
    </div>
</section>

<section class="section">
    <header class="section__head">
        <span class="section__num">03</span>
        <h2 class="section__title">What to do next</h2>
    </header>
    <p>${escapeHtml(next.intro)}</p>
    ${planBlocks}
</section>

<section class="section">
    <header class="section__head">
        <span class="section__num">04</span>
        <h2 class="section__title">What success looks like</h2>
    </header>
    <p>An AI-ready organisation does not replace people with technology. It uses AI to reduce friction, improve coordination, strengthen governance and give staff more time for judgement, relationships and delivery.</p>
    ${successBlocks}
</section>

<section class="section">
    <header class="section__head">
        <span class="section__num">05</span>
        <h2 class="section__title">About Creative Thinking Systems</h2>
    </header>
    <div class="about">
        <p>Creative Thinking Systems is an applied AI research, development and production entity focused exclusively on cultural and creative industries. We work with cultural organisations across Europe and the Middle East to design and build AI tools, strategies and policies that fit how culture actually works.</p>
        <p>This report is a starting point. If you would like help moving from diagnostic to action, get in touch.</p>
        <p class="about__contact">creativethinkingsystems.com<br>hello@creativethinkingsystems.com</p>
    </div>
</section>

</body>
</html>`;
}

function reportPageHeaderFooter(organisation) {
    const dateStr = dateString();
    const safeOrg = escapeHtml(organisation && organisation.trim() ? organisation.trim() : '');
    const header = `
        <style>
          .hf { width:100%; font-family: 'Helvetica', 'Arial', sans-serif; font-size: 8pt; color: #1a1a1a; padding: 0 18mm 0 25mm; }
          .hf .row { display: flex; justify-content: space-between; align-items: flex-start; }
          .hf .b-name { font-weight: 600; }
          .hf .b-url { color: #555; font-size: 7.5pt; }
          .hf .doc-date { font-weight: 500; }
        </style>
        <div class="hf"><div class="row">
            <div><div class="b-name">Creative Thinking Systems</div><div class="b-url">creativethinkingsystems.com</div></div>
            <div class="doc-date">${dateStr}</div>
        </div></div>`;
    const footer = `
        <style>
          .hf { width:100%; font-family: 'Helvetica', 'Arial', sans-serif; font-size: 7.5pt; color: #1a1a1a; padding: 0 18mm 0 25mm; }
          .hf .row { display: flex; justify-content: space-between; padding-top: 3mm; border-top: 0.6pt solid #1a1a1a; }
          .hf .left { font-weight: 500; }
          .hf .sep { color: #999; padding: 0 2mm; }
          .hf .b-url { color: #555; }
        </style>
        <div class="hf"><div class="row">
            <div class="left">Creative Thinking Systems <span class="sep">·</span> <span class="b-url">creativethinkingsystems.com</span></div>
            <div>${safeOrg ? safeOrg + ' <span class="sep">·</span> ' : ''}AI Readiness Report <span class="sep">·</span> <span class="pageNumber"></span></div>
        </div></div>`;
    return { header, footer };
}

module.exports = { buildReportHtml, reportPageHeaderFooter, bandFor };
