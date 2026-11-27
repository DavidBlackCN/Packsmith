const userAgent = 'DavidBlackCN/Packsmith/3 (https://github.com/DavidBlackCN)';
const batchSize = 100;
const sha1Pattern = /^[0-9a-f]{40}$/i;
const sha512Pattern = /^[0-9a-f]{128}$/i;
const text = value => typeof value === 'string' && value.length > 0;
const strings = values => Array.isArray(values) ? values.filter(text) : undefined;
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const unverified = reason => ({ status: 'unverified', reason });
const notQueried = reason => ({ status: 'not-queried', reason });

function modrinthResult(versions, item) {
  const hash = item.sha512.toLowerCase();
  if (!Object.hasOwn(versions, hash)) return { status: 'no-match' };
  const version = versions[hash];
  const files = version?.files?.filter(file => file.hashes?.sha512?.toLowerCase() === hash);
  if (files?.length !== 1 || !text(version.project_id) || !text(version.id)) {
    return unverified('响应未指向唯一的项目、版本和发布文件');
  }
  const [file] = files;
  const sha1 = file.hashes.sha1?.toLowerCase();
  if (item.size !== file.size || !text(file.filename) ||
      (item.sha1 !== undefined && item.sha1.toLowerCase() !== sha1)) {
    return unverified('发布文件的长度、SHA-1 或文件名与采集证据无法对应');
  }
  return {
    status: 'exact',
    release: {
      projectId: version.project_id, versionId: version.id, version: version.version_number,
      fileName: file.filename, size: file.size, hashes: { sha512: hash, ...(sha1 ? { sha1 } : {}) },
      gameVersions: strings(version.game_versions), loaders: strings(version.loaders),
      dependencies: version.dependencies?.map(dep => ({
        type: dep.dependency_type, ...(dep.project_id ? { projectId: dep.project_id } : {}),
        ...(dep.version_id ? { versionId: dep.version_id } : {}), ...(dep.file_name ? { fileName: dep.file_name } : {}),
      })),
    },
  };
}

const cfLoaders = new Set(['forge', 'fabric', 'neoforge', 'quilt', 'liteloader', 'rift', 'cauldron']);
const cfRelations = [null, 'embedded', 'optional', 'required', 'tool', 'incompatible', 'include'];
// CurseForge mixes MC versions, loaders, Java versions and environment tags in gameVersions.
// Keep the original tags as well as the version and loader dimensions usable for comparison.
const mcVersion = /^(?:\d+\.\d+(?:\.(?:\d+|x))?(?:[- ](?:pre(?:-?release)?|rc|release candidate|snapshot)[- ]?\d+)?|\d{2}w\d{2}[a-z])$/i;

function curseforgeResult(data, item) {
  const fingerprint = item.curseforgeFingerprint;
  const matches = data.exactMatches.filter(match => match.file?.fileFingerprint === fingerprint);
  if (!matches.length) {
    const partial = (data.partialMatches ?? []).some(match => match.file?.fileFingerprint === fingerprint ||
      match.file?.modules?.some(module => module.fingerprint === fingerprint));
    const partialGroups = data.partialMatchFingerprints ?? {};
    if (partial || Object.values(partialGroups).some(group => Array.isArray(group) && group.includes(fingerprint))) {
      return unverified('CurseForge 仅返回部分指纹匹配');
    }
    if (data.exactFingerprints?.includes(fingerprint)) return unverified('精确指纹列表缺少可核对的文件记录');
    if (data.isCacheBuilt === false) return { status: 'error', reason: 'CurseForge 指纹索引尚未就绪' };
    return { status: 'no-match' };
  }
  const confirmed = matches.map(match => match.file).filter(file => {
    const sha1s = file.hashes?.filter(hash => hash.algo === 1);
    return (file.gameId === undefined || file.gameId === 432) && positiveId(file.modId) && positiveId(file.id) &&
      text(file.fileName) && file.fileLength === item.size && sha1s?.length > 0 &&
      sha1s.every(hash => hash.value?.toLowerCase() === item.sha1.toLowerCase());
  });
  if (confirmed.length !== 1) return unverified('指纹命中，但无法用原始 SHA-1 和长度确认唯一发布文件');
  const [file] = confirmed;
  const tags = strings(file.gameVersions);
  return {
    status: 'exact',
    release: {
      projectId: String(file.modId), fileId: String(file.id), displayName: file.displayName, fileName: file.fileName,
      size: file.fileLength, hashes: { sha1: item.sha1.toLowerCase() }, fingerprint,
      gameVersionTags: tags, gameVersions: tags?.filter(tag => mcVersion.test(tag)),
      loaders: tags?.map(tag => tag.toLowerCase()).filter(tag => cfLoaders.has(tag)),
      dependencies: file.dependencies?.map(dep => ({
        projectId: String(dep.modId), type: cfRelations[dep.relationType] ?? 'unknown', relationType: dep.relationType,
      })),
    },
  };
}

async function lookupPlatform(items, results, platform, key, fetchImpl) {
  const modrinth = platform === 'modrinth';
  const groups = new Map();
  for (const item of items) {
    if (!Number.isSafeInteger(item.size) || item.size < 0) continue;
    if (modrinth) {
      if (!text(item.sha512) || !sha512Pattern.test(item.sha512) ||
          (item.sha1 !== undefined && (!text(item.sha1) || !sha1Pattern.test(item.sha1)))) continue;
    } else if (!Number.isInteger(item.curseforgeFingerprint) || item.curseforgeFingerprint < 0 ||
      item.curseforgeFingerprint > 0xffffffff || !text(item.sha1) || !sha1Pattern.test(item.sha1)) continue;
    const id = modrinth ? item.sha512.toLowerCase() : item.curseforgeFingerprint;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  const ids = [...groups.keys()];
  const url = modrinth ? 'https://api.modrinth.com/v2/version_files' : 'https://api.curseforge.com/v1/fingerprints/432';
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent };
  if (!modrinth) headers['x-api-key'] = key;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const body = modrinth ? { algorithm: 'sha512', hashes: batch } : { fingerprints: batch };
    let reason = '平台连接失败、超时或返回了无效的响应';
    try {
      const response = await fetchImpl(url, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        reason = '平台返回 HTTP ' + response.status;
        throw new Error(reason);
      }
      const json = await response.json();
      if (!json || typeof json !== 'object' || Array.isArray(json) || (!modrinth && !Array.isArray(json.data?.exactMatches))) {
        throw new Error('响应格式无效');
      }
      for (const id of batch) {
        for (const item of groups.get(id)) {
          results.get(item.sha256)[platform] = modrinth ? modrinthResult(json, item) : curseforgeResult(json.data, item);
        }
      }
    } catch {
      // Do not send more batches on this platform after a failure or rate limit.
      // Error bodies and transport errors can repeat headers; only expose the HTTP status.
      for (const id of batch) {
        for (const item of groups.get(id)) results.get(item.sha256)[platform] = { status: 'error', reason };
      }
      for (const id of ids.slice(offset + batchSize)) {
        for (const item of groups.get(id)) results.get(item.sha256)[platform] = notQueried('上一批查询失败，已停止此平台的请求');
      }
      break;
    }
  }
}

export async function lookupReleases(items, { offline = false, curseforgeKey = process.env.CURSEFORGE_API_KEY, fetchImpl = fetch } = {}) {
  const results = new Map();
  for (const item of items) {
    results.set(item.sha256, {
      modrinth: notQueried(offline ? '离线模式' : '缺少查询所需的文件哈希或长度'),
      curseforge: notQueried(offline ? '离线模式' : !curseforgeKey ? '未配置 CurseForge API key' : '缺少指纹、SHA-1 或文件长度'),
    });
  }
  if (offline) return results;
  await Promise.all([
    lookupPlatform(items, results, 'modrinth', null, fetchImpl),
    ...(curseforgeKey ? [lookupPlatform(items, results, 'curseforge', curseforgeKey, fetchImpl)] : []),
  ]);
  return results;
}
