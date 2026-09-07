type OwnerPathSource = {
  id: number;
  seasonId: number;
  ruleId: number;
};

export const getOwnerRevalidatePaths = (owner: OwnerPathSource, horseId: number) => {
  return [
    `/${owner.seasonId}/${owner.ruleId}`,
    `/${owner.seasonId}/${owner.ruleId}/${owner.id}`,
    `/${owner.seasonId}/${owner.ruleId}/${owner.id}/${horseId}`,
  ];
};

export const postRevalidate = async (paths: string[]) => {
  const appUrl = process.env.APP_URL;
  const secret = process.env.REVALIDATE_SECRET;
  const uniquePaths = [...new Set(paths)];

  if (uniquePaths.length === 0) {
    return;
  }

  if (!appUrl || !secret) {
    console.log("APP_URL or REVALIDATE_SECRET is not set: skipped revalidate");
    return;
  }

  const response = await fetch(new URL("/api/revalidate", appUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      secret,
      paths: uniquePaths,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to revalidate paths: ${response.status} ${response.statusText}`);
  }

  console.log(`revalidated paths: ${uniquePaths.length}`);
};
