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

// Notice to the CVM inbox (forwards to Conor) when someone asks for a lookup invite.
// Reply-to is the requester, so a reply goes straight to them.
// Where an invite request came from, in words, from the source tag the lookup page sends
// ("cvm-lookup" for the main sign-in page, "cvm-lookup-<slug>" for an invite page at /lookup-preview/<slug>/).
function describeInviteSource(source) {
    const base = 'https://creativevaluemonitor.ai/lookup-preview/';
    if (source === 'cvm-lookup') return { label: 'Lookup Preview sign-in page', url: base };
    const m = /^cvm-lookup-([a-z0-9-]+)$/.exec(source || '');
    if (m) return { label: `Lookup Preview invite page (${m[1]})`, url: `${base}${m[1]}/` };
    return { label: 'Not recorded', url: null };
}

async function sendInviteRequestNotice({ apiKey, email, organisation, source, requests, receivedAt, code }) {
    const resend = client(apiKey);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const org = organisation || 'Not given';
    const from = describeInviteSource(source);
    const when = (receivedAt || new Date()).toLocaleString('en-GB', {
        timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }) + ' (UK time)';
    const history = requests > 1 ? `Request ${requests} from this address` : 'First request from this address';
    // The invite link carries the code after "#", so it opens the preview directly and the code never reaches the server.
    const inviteLink = code && from.url ? `${from.url}#k=${encodeURIComponent(code)}` : null;
    const rows = [
        ['Email', email],
        ['Organisation', org],
        ['Requested from', from.label],
        ['Received', when],
        ['History', history],
    ];
    if (inviteLink) rows.push(['Invite link', inviteLink], ['Invite code', code]);

    // A ready-written invite, opened in the mail app as a reply to the requester.
    const inviteSubject = 'Invite to the Creative Value Monitor Lookup Preview';
    const inviteBody = inviteLink ? [
        'Hello,', '',
        'Here is an invite to the Creative Value Monitor Lookup Preview.', '',
        `Open the preview: ${inviteLink}`, '',
        `The link signs in directly. On the sign-in page (${from.url}), the invite code is: ${code}`, '',
        "The preview shows whether a domain's content is in AI training data, how much of it, and what it is worth a year.", '',
        'Creative Value Monitor', 'hello@creativevaluemonitor.ai',
    ].join('\n') : '';
    // Gmail's compose window fills To, Subject and the message reliably; the mailto link is for any other mail app.
    // The address goes in as written (it was validated), so mail apps show it in the To field.
    const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const gmailInvite = inviteLink ? `https://mail.google.com/mail/?view=cm&fs=1&${q({ to: email, su: inviteSubject, body: inviteBody })}` : null;
    const sendInvite = inviteLink ? `mailto:${encodeURI(email)}?${q({ subject: inviteSubject, body: inviteBody })}` : null;

    const next = inviteLink
        ? `To grant access, use Send invite: it opens a ready-written invite to ${email} in Gmail. Replies to this email also go straight to the requester.`
        : 'To grant access, reply with the invite link for the page above. Replies go straight to the requester.';
    const text = 'New request for an invite to the Lookup Preview.\n\n'
        + rows.map(([k, v]) => `${k}: ${v}`).join('\n')
        + `\n\n${next}\n`
        + (inviteLink ? `\nSend invite in Gmail: ${gmailInvite}\n\n--- Invite to send ---\nTo: ${email}\nSubject: ${inviteSubject}\n\n${inviteBody}\n` : '');
    const cell = (k, v) => {
        if (k === 'Email') return `<a href="mailto:${esc(v)}" style="${linkStyle()}">${esc(v)}</a>`;
        if (k === 'Requested from' && from.url) return `<a href="${from.url}" style="${linkStyle()}">${esc(v)}</a>`;
        if (k === 'Invite link') return `<a href="${esc(v)}" style="${linkStyle()}">${esc(v)}</a>`;
        if (k === 'Invite code') return `<code style="font-size:14px;">${esc(v)}</code>`;
        return esc(v);
    };
    const table = rows.map(([k, v]) => `<tr><td style="padding:3px 18px 3px 0;color:#6b6b6b;white-space:nowrap;vertical-align:top;">${esc(k)}</td>`
        + `<td style="padding:3px 0;word-break:break-all;">${cell(k, v)}</td></tr>`).join('');
    const button = gmailInvite
        ? `<a href="${esc(gmailInvite)}" style="display:inline-block;background:#082546;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:4px;font-weight:600;">Send invite</a>`
          + `<span style="display:inline-block;margin-left:14px;font-size:13px;"><a href="${esc(sendInvite)}" style="${linkStyle()}">Or open in the default mail app</a></span>`
        : null;
    return resend.emails.send({
        from: `Creative Value Monitor <${FROM_EMAIL}>`,
        to: 'hello@creativevaluemonitor.ai',
        replyTo: email,
        subject: `Lookup Preview invite request: ${organisation ? `${organisation} (${email})` : email}`,
        text,
        html: htmlShell([
            'New request for an invite to the Lookup Preview.',
            `<table style="border-collapse:collapse;font-size:15px;">${table}</table>`,
            ...(button ? [button] : []),
            next,
        ]),
    });
}

module.exports = { sendWorkbookEmail, sendReportEmail, sendInviteRequestNotice };
