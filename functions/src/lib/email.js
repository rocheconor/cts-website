const { Resend } = require('resend');

const FROM_NAME = 'Creative Thinking Systems';
const FROM_EMAIL = 'hello@creativethinkingsystems.com';

function client(apiKey) {
    if (!apiKey) throw new Error('Missing RESEND_API_KEY');
    return new Resend(apiKey);
}

// Minimal inline-styled HTML shell so the email reads well in Gmail / Apple Mail
// without depending on remote stylesheets. Keeps the layout to plain paragraphs;
// the only interactive bit is the "here" hyperlink.
function htmlShell(paragraphs) {
    const inner = paragraphs.map((p) => `<p style="margin:0 0 14px;">${p}</p>`).join('');
    return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.55; color: #1a1a1a;">
<div style="max-width: 560px;">
${inner}
</div></body></html>`;
}

function linkStyle() {
    return 'color:#1a1a1a; text-decoration: underline;';
}

async function sendWorkbookEmail({ apiKey, to, downloadUrl, attachmentBytes }) {
    const resend = client(apiKey);
    const subject = 'Your AI Readiness Workbook';

    const html = htmlShell([
        'Hello,',
        `Thanks for downloading the AI Readiness Workbook. It is attached to this email. You can also download it directly <a href="${downloadUrl}" style="${linkStyle()}">here</a>.`,
        'The workbook gives your organisation a practical framework for understanding where it stands on AI, and what to do next. It is designed to be used by an executive team, a senior management group, or a board.',
        'If you would like to talk through what comes after the workbook, just reply to this email.',
        'Best,<br>Conor Roche<br>Creative Thinking Systems<br><a href="https://creativethinkingsystems.com" style="' + linkStyle() + '">creativethinkingsystems.com</a>',
    ]);

    const text =
`Hello,

Thanks for downloading the AI Readiness Workbook. It is attached to this email. You can also download it directly here:
${downloadUrl}

The workbook gives your organisation a practical framework for understanding where it stands on AI, and what to do next. It is designed to be used by an executive team, a senior management group, or a board.

If you would like to talk through what comes after the workbook, just reply to this email.

Best,
Conor Roche
Creative Thinking Systems
creativethinkingsystems.com
`;

    return resend.emails.send({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to,
        subject,
        text,
        html,
        attachments: attachmentBytes ? [{
            filename: 'AI-Readiness-Workbook.pdf',
            content: Buffer.isBuffer(attachmentBytes) ? attachmentBytes : Buffer.from(attachmentBytes),
        }] : undefined,
    });
}

async function sendReportEmail({ apiKey, to, downloadUrl, attachmentBytes }) {
    const resend = client(apiKey);
    const subject = 'Your AI Readiness Report';

    const html = htmlShell([
        'Hello,',
        `Your personalised AI Readiness Report is attached. You can also download it directly <a href="${downloadUrl}" style="${linkStyle()}">here</a>.`,
        'It includes your scores across the eight areas, an interpretation of where your organisation sits, and a 30/60/90 action plan tailored to your result.',
        'If you would like to talk through any of it, just reply to this email.',
        'Best,<br>Conor Roche<br>Creative Thinking Systems<br><a href="https://creativethinkingsystems.com" style="' + linkStyle() + '">creativethinkingsystems.com</a>',
    ]);

    const text =
`Hello,

Your personalised AI Readiness Report is attached. You can also download it directly here:
${downloadUrl}

It includes your scores across the eight areas, an interpretation of where your organisation sits, and a 30/60/90 action plan tailored to your result.

If you would like to talk through any of it, just reply to this email.

Best,
Conor Roche
Creative Thinking Systems
creativethinkingsystems.com
`;

    return resend.emails.send({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to,
        subject,
        text,
        html,
        attachments: attachmentBytes ? [{
            filename: 'AI-Readiness-Report.pdf',
            content: Buffer.isBuffer(attachmentBytes) ? attachmentBytes : Buffer.from(attachmentBytes),
        }] : undefined,
    });
}

module.exports = { sendWorkbookEmail, sendReportEmail };
