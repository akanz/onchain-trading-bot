import type { Json } from "./types.js";

export class OpenTwitterClient {
  readonly token = process.env.TWITTER_TOKEN ?? process.env.OPENNEWS_TOKEN;
  readonly baseUrl = process.env.OPENTWITTER_BASE_URL ?? "https://ai.6551.io";
  get enabled() {
    return Boolean(this.token);
  }

  private async post(path: string, body: Json): Promise<any> {
    if (!this.token) throw new Error("TWITTER_TOKEN is not configured");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`OpenTwitter request failed (${response.status})`);
    return response.json();
  }

  async userTweets(username: string, maxResults = 10): Promise<Json[]> {
    const payload = await this.post("/open/twitter_user_tweets", {
      username,
      maxResults,
      product: "Latest",
      includeReplies: false,
      includeRetweets: false,
    });
    if (Array.isArray(payload)) return payload;
    for (const value of [payload?.data, payload?.tweets, payload?.data?.tweets, payload?.result])
      if (Array.isArray(value)) return value;
    return [];
  }
}
