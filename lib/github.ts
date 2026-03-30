/**
 * GitHub API helper for pushing files to a repo (e.g. Obsidian vault).
 * Uses the GitHub Contents API — no git dependency needed.
 */

const GITHUB_API = "https://api.github.com";

interface PushFileOptions {
  repo: string;       // e.g. "austinntowns/obsidian-vaults"
  path: string;       // e.g. "Austin's Brain/Hello Sugar/Daily Briefing/2026-03-29.md"
  content: string;    // file content (will be base64-encoded)
  message: string;    // commit message
  token: string;      // GitHub PAT
}

/**
 * Create or update a file in a GitHub repo via the Contents API.
 * If the file already exists, fetches its SHA first to enable update.
 */
export async function pushFileToGitHub(opts: PushFileOptions): Promise<void> {
  const { repo, path: filePath, content, message, token } = opts;
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(filePath)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };

  // Check if file exists (to get SHA for update)
  let sha: string | undefined;
  const getRes = await fetch(url, { headers });
  if (getRes.ok) {
    const existing = (await getRes.json()) as { sha: string };
    sha = existing.sha;
  }

  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
  };
  if (sha) {
    body.sha = sha;
  }

  const putRes = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub API error (${putRes.status}): ${err}`);
  }
}
