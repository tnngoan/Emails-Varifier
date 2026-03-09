import * as net from 'net';
import { SmtpConfig } from '../types/index.js';

// ─── SMTP Mailbox Verification via TCP ───────────────────────────────────────
//
// This module performs a raw SMTP handshake over TCP to check whether a
// mailbox exists. NO email is sent — we disconnect immediately after RCPT TO.
//
// SMTP Dialog:
//   S: 220 mail.example.com ESMTP Ready
//   C: EHLO verifier.example.com
//   S: 250-mail.example.com ... (multi-line)
//   C: MAIL FROM:<probe@verifier.example.com>
//   S: 250 OK
//   C: RCPT TO:<target@domain.com>
//   S: 250 OK  ← VALID  /  550 No such user  ← INVALID
//   C: QUIT
//   S: 221 Bye
//   [connection closed]
//
// SMTP Response code families:
//   2xx → success
//   4xx → temporary failure (greylist, throttle)
//   5xx → permanent failure (bad mailbox, policy)

export type SmtpCheckCode =
  | 'VALID'       // RCPT TO: 250
  | 'INVALID'     // RCPT TO: 550/551/553
  | 'GREYLISTED'  // RCPT TO: 421/450/451
  | 'UNKNOWN'     // timeout, unexpected response, connection refused
  | 'POLICY';     // 421 at EHLO/MAIL FROM (server-level block, not mailbox)

export interface SmtpCheckResult {
  code: SmtpCheckCode;
  smtpResponseCode: number;
  smtpResponseMessage: string;
  mxHost: string;
}

// ─── Main SMTP Check ──────────────────────────────────────────────────────────

export async function smtpCheck(
  mxHost: string,
  email: string,
  smtpConfig: SmtpConfig
): Promise<SmtpCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    let state: 'connect' | 'ehlo' | 'mail_from' | 'rcpt_to' | 'quit' = 'connect';
    let buffer = '';

    const done = (result: SmtpCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    // ── Timeout guard ────────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      done({
        code: 'UNKNOWN',
        smtpResponseCode: 0,
        smtpResponseMessage: `Connection timed out after ${smtpConfig.timeoutMs}ms`,
        mxHost,
      });
    }, smtpConfig.timeoutMs);

    // ── TCP socket ───────────────────────────────────────────────────────────
    const socket = net.createConnection({ host: mxHost, port: smtpConfig.port });
    socket.setEncoding('utf8');
    socket.setTimeout(smtpConfig.timeoutMs);

    socket.on('timeout', () => {
      done({
        code: 'UNKNOWN',
        smtpResponseCode: 0,
        smtpResponseMessage: 'Socket timeout',
        mxHost,
      });
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const msg = err.code === 'ECONNREFUSED'
        ? `Connection refused to ${mxHost}:${smtpConfig.port}`
        : err.message;
      done({
        code: 'UNKNOWN',
        smtpResponseCode: 0,
        smtpResponseMessage: msg,
        mxHost,
      });
    });

    // ── Response parser ───────────────────────────────────────────────────────
    socket.on('data', (chunk: string) => {
      buffer += chunk;

      // SMTP responses may be multi-line. Each line ends with \r\n.
      // A final response line has a SPACE after the code; continuation lines
      // have a DASH.  e.g.:  "250-PIPELINING\r\n250 OK\r\n"
      // We process complete response groups only.
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? ''; // keep incomplete last chunk

      for (const line of lines) {
        if (!line) continue;

        const codeStr = line.slice(0, 3);
        const isFinal = line.length >= 4 && line[3] === ' ';
        const code    = parseInt(codeStr, 10);

        if (!isFinal) continue; // wait for the final line of a multi-line response

        handleResponse(code, line.slice(4).trim());
      }
    });

    // ── State machine ─────────────────────────────────────────────────────────
    function handleResponse(code: number, message: string) {
      switch (state) {
        case 'connect': {
          // Expect 220 Service Ready
          if (code === 220) {
            state = 'ehlo';
            socket.write(`EHLO ${smtpConfig.heloHost}\r\n`);
          } else {
            done({ code: 'UNKNOWN', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          }
          break;
        }

        case 'ehlo': {
          if (code === 250) {
            state = 'mail_from';
            socket.write(`MAIL FROM:<${smtpConfig.fromAddress}>\r\n`);
          } else if (code >= 400 && code < 500) {
            // Temporary failure at EHLO — server-level throttle
            done({ code: 'POLICY', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          } else {
            done({ code: 'UNKNOWN', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          }
          break;
        }

        case 'mail_from': {
          if (code === 250) {
            state = 'rcpt_to';
            socket.write(`RCPT TO:<${email}>\r\n`);
          } else if (code >= 400 && code < 500) {
            done({ code: 'POLICY', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          } else {
            done({ code: 'UNKNOWN', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          }
          break;
        }

        case 'rcpt_to': {
          // This is the critical response — does the mailbox exist?
          state = 'quit';
          socket.write('QUIT\r\n');

          if (code === 250 || code === 251) {
            // 250 = OK, 251 = User not local but will forward → both mean deliverable
            done({ code: 'VALID', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          } else if (code === 550 || code === 551 || code === 553 || code === 554) {
            // 550 = No such user, 551 = Not local, 553 = Bad name, 554 = Rejected
            done({ code: 'INVALID', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          } else if (code === 421 || code === 450 || code === 451 || code === 452) {
            // 421 = Server unavailable, 45x = Temp failure → greylist candidate
            done({ code: 'GREYLISTED', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          } else {
            done({ code: 'UNKNOWN', smtpResponseCode: code, smtpResponseMessage: message, mxHost });
          }
          break;
        }

        case 'quit': {
          // 221 = closing — just let the socket close naturally
          socket.destroy();
          break;
        }
      }
    }
  });
}
