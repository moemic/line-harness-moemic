import { pathToFileURL } from 'node:url';

export const targets = {
  line: { repository: 'Shudesu/line-harness-oss', worker: 'line-harness', url: 'https://line-harness.main-d59.workers.dev', database: 'feebed29-207d-418e-a8a4-d05375fdca67' },
  x: { repository: 'Shudesu/x-harness-oss', worker: 'x-harness-worker', url: 'https://x-harness-worker.main-d59.workers.dev', database: '55c1d3b8-a47e-41b6-a4f8-fed1654031f8' },
};

export function validateDatabase(settings, target) {
  const bindings = settings.bindings.filter(binding => binding.type === 'd1');
  if (bindings.length !== 1 || bindings[0].name !== 'DB' || bindings[0].id !== target.database) {
    throw new Error(`${target.worker}: 既存D1と設定が一致しません`);
  }
}

async function request(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Harness-Auto-Update' } });
  if (!response.ok) throw new Error(`API確認失敗: HTTP ${response.status}`);
  const data = await response.json();
  if (data.success === false) throw new Error('Cloudflare API確認失敗');
  return data.result ?? data;
}

async function audit() {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, GH_TOKEN: githubToken } = process.env;
  if (!account || !token || !githubToken) throw new Error('既存のCloudflare／GitHub認証が必要です');
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  for (const [name, target] of Object.entries(targets)) {
    const settings = await request(`${api}/workers/scripts/${target.worker}/settings`, token);
    validateDatabase(settings, target);
    const deployments = await request(`${api}/workers/scripts/${target.worker}/deployments`, token);
    const release = await request(`https://api.github.com/repos/${target.repository}/releases/latest`, githubToken);
    console.log(JSON.stringify({ harness: name, worker: target.worker, databaseVerified: true, bindings: settings.bindings.map(binding => ({ name: binding.name, type: binding.type })), latestDeployment: deployments.deployments[0], release: release.tag_name, publishedAt: release.published_at }));
  }
  const pages = await request(`${api}/pages/projects/x-harness-web`, token);
  console.log(JSON.stringify({ xAdmin: pages.subdomain, latestDeployment: pages.canonical_deployment?.id }));
  if (process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID) {
    const team = process.env.VERCEL_ORG_ID;
    const project = await request(`https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}${team ? `?teamId=${team}` : ''}`, process.env.VERCEL_TOKEN);
    console.log(JSON.stringify({ lineAdmin: { name: project.name, rootDirectory: project.rootDirectory, repository: project.link?.repo, productionBranch: project.link?.productionBranch, aliases: project.targets?.production?.alias } }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await audit();
}
