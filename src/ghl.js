// Mirror each lead's waitlist status onto their GoHighLevel contact as tags,
// so the waitlist is visible (and filterable) inside GoHighLevel.

const GHL_API = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

/**
 * Add and/or remove waitlist tags on a contact. Tag names are TAG_PREFIX + name,
 * e.g. "jean-imessage-" + "sent". Does nothing without GHL_API_KEY or a contact id.
 * Never throws: a tagging problem must not stop messages from being sent.
 */
export async function updateTags(env, contactId, { add = [], remove = [] }) {
  if (!env.GHL_API_KEY || !contactId) return;
  const prefix = env.TAG_PREFIX ?? "imessage-";
  const ops = [
    ["POST", add],
    ["DELETE", remove],
  ];
  for (const [method, names] of ops) {
    if (names.length === 0) continue;
    const tags = names.map((n) => prefix + n);
    try {
      const res = await fetch(`${GHL_API}/contacts/${encodeURIComponent(contactId)}/tags`, {
        method,
        headers: {
          Authorization: `Bearer ${env.GHL_API_KEY}`,
          Version: GHL_API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.log(`GoHighLevel tag ${method} ${tags.join(", ")} failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.log(`GoHighLevel tag ${method} ${tags.join(", ")} failed:`, String(err));
    }
  }
}
