/** Discord rejects messages over 2,000 characters; stay under with room to spare. */
export const DISCORD_MAX_CHARS = 1900;

/**
 * Posts `content` to a Discord webhook. Never throws: a non-2xx answer or a
 * thrown fetch is dropped. With no webhook it logs one warning, which holds no
 * inputs and no URLs.
 */
export async function postDiscord(
  fetcher: typeof fetch,
  webhookUrl: string | undefined,
  content: string,
): Promise<void> {
  if (!webhookUrl) {
    console.warn("competitive-analysis: no Discord webhook is set, so a self-check message was not posted");
    return;
  }
  const text = content.length > DISCORD_MAX_CHARS ? `${content.slice(0, DISCORD_MAX_CHARS - 1)}…` : content;
  try {
    const res = await fetcher(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    await res.body?.cancel();
  } catch {
    // Silent on purpose: the error could carry the webhook URL.
  }
}
