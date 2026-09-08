export const NETKEIBA_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// netkeiba がアクセス制限をかけた時のエラー。呼び出し側はこれを受けたら処理全体を止める
export class NetkeibaBlockedError extends Error {
  constructor(url: string, status: number) {
    super(`Blocked by netkeiba (${status}): ${url}`);
    this.name = "NetkeibaBlockedError";
  }
}

type FetchTextOptions = {
  referer?: string;
  encoding?: "utf-8" | "euc-jp";
};

export const fetchNetkeibaText = async (url: string, options: FetchTextOptions = {}) => {
  const response = await fetch(url, {
    headers: {
      ...(options.referer ? { referer: options.referer } : {}),
      "user-agent": NETKEIBA_USER_AGENT,
    },
  });

  if (response.status === 403 || response.status === 429) {
    throw new NetkeibaBlockedError(url, response.status);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return new TextDecoder(options.encoding ?? "utf-8").decode(buffer);
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
