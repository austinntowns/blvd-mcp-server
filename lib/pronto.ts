/**
 * Pronto API helper for sending messages to chats.
 */

const PRONTO_API = "https://api.pronto.io/api";

interface SendMessageOptions {
  chatId: string;
  message: string;
  token: string;
}

/**
 * Send a message to a Pronto chat.
 */
export async function sendProntoMessage(opts: SendMessageOptions): Promise<void> {
  const { chatId, message, token } = opts;

  const res = await fetch(`${PRONTO_API}/chats/${chatId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: message }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pronto API error (${res.status}): ${err}`);
  }
}
