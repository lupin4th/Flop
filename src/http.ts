import https from 'node:https';

export type HttpResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/**
 * The one network primitive the agent uses, kept this small so tests can
 * replace it with a fake and assert on exactly what would have been sent.
 */
export type Http = (method: 'GET' | 'POST', url: string, body?: string) => Promise<HttpResponse>;

const TIMEOUT_MS = 30_000;
const USER_AGENT = 'technocore-attest-agent/0.1';

/** HTTPS only. A JSON `body`, when given, is sent with POST. */
export const httpsRequest: Http = (method, url, body) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      reject(new Error(`refusing a non-HTTPS request to ${u.host}`));
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json, text/plain, */*',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request to ${u.host} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
