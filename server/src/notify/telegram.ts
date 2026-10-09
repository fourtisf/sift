import { config } from '../config.js';
import type { Store } from '../store/db.js';

/** Sends trade alerts and links chats with "/start <code>". Long-polls, so no webhook URL is needed. */
export class Telegram {
  private offset = 0;
  private stopped = false;
  constructor(private store: Store) {}

  get enabled() {
    return !!config.telegramToken;
  }

  private api(method: string, body: unknown) {
    return fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async send(chat: string | null, text: string) {
    if (!this.enabled || !chat) return;
    try {
      await this.api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
    } catch {
      /* alerts are best-effort */
    }
  }

  start() {
    if (!this.enabled) return;
    const loop = async () => {
      while (!this.stopped) {
        try {
          const r = await this.api('getUpdates', { offset: this.offset, timeout: 25 });
          const body = (await r.json()) as { result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };
          for (const u of body.result ?? []) {
            this.offset = u.update_id + 1;
            const m = u.message;
            const code = m?.text?.match(/^\/start\s+(\w+)/)?.[1];
            if (!m || !code) continue;
            const user = this.store.userByTgCode(code);
            if (!user) {
              await this.send(String(m.chat.id), 'That link has expired. Open Sift and press "Connect Telegram" again.');
              continue;
            }
            this.store.setTelegram(user.address, String(m.chat.id), null);
            await this.send(String(m.chat.id), '✅ Connected. You will get a message every time your agent buys or sells.');
          }
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
    void loop();
  }

  stop() {
    this.stopped = true;
  }
}
