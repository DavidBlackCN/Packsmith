const algorithms = ['sha512', 'sha256', 'sha1'];
const platforms = ['modrinth', 'curseforge'];
const overrideRules = { common: 'overrides', client: 'client_overrides', server: 'server_overrides' };

function append(index, key, value) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

export function isTargetMod(destination, config) {
  const name = destination.toLowerCase();
  const modsRoot = (config.paths?.mods ?? 'mods').toLowerCase();
  return name.endsWith('.jar') && (name.startsWith('mods/') || name.startsWith(modsRoot + '/'));
}

function lockComparison(lock) {
  const byHash = new Map();
  const byProject = new Map();
  for (const project of lock.projects ?? []) {
    if (project.type !== 'MOD') continue;
    const side = { BOTH: 'common', CLIENT: 'client', SERVER: 'server' }[project.side] ?? null;
    const files = (project.files ?? []).map(file => ({
      pakkuId: project.pakku_id,
      side,
      platform: file.type,
      projectId: String(project.id?.[file.type] ?? file.parent_id ?? ''),
      fileId: file.id == null ? null : String(file.id),
      fileName: file.file_name ?? null,
      hashes: file.hashes ?? {},
      size: file.size,
    }));
    for (const file of files) {
      for (const algorithm of algorithms) {
        const hash = file.hashes[algorithm];
        if (hash) append(byHash, algorithm + ':' + hash.toLowerCase(), file);
      }
    }
    for (const platform of platforms) {
      const platformFiles = files.filter(file => file.platform === platform);
      const id = project.id?.[platform] ?? platformFiles[0]?.projectId;
      if (id == null || id === '') continue;
      // A multiplatform project can have an ID on both services but a file on only one.
      const details = platformFiles.length ? platformFiles : files;
      const fallback = { pakkuId: project.pakku_id, side, platform, projectId: String(id), fileId: null, fileName: null };
      for (const file of details.length ? details : [fallback]) append(byProject, platform + ':' + id, file);
    }
  }

  return (item, releases) => {
    const exact = new Map();
    for (const algorithm of algorithms) {
      if (!item[algorithm]) continue;
      for (const file of byHash.get(algorithm + ':' + item[algorithm].toLowerCase()) ?? []) {
        if (exact.has(file) || (file.size != null && file.size !== item.size)) continue;
        if (algorithms.some(key => file.hashes[key] && item[key] &&
            file.hashes[key].toLowerCase() !== item[key].toLowerCase())) continue;
        exact.set(file, { ...file, matchedBy: algorithm });
      }
    }
    if (exact.size) return [...exact.values()];

    const matches = [];
    for (const platform of platforms) {
      if (releases[platform]?.status !== 'exact') continue;
      const release = releases[platform].release;
      const releaseId = release.versionId ?? release.fileId;
      for (const file of byProject.get(platform + ':' + release.projectId) ?? []) {
        matches.push({ ...file, matchedBy: 'project-id', matchedPlatform: platform,
          matchedProjectId: String(release.projectId), releaseId,
          sameReleaseId: file.platform === platform && file.fileId != null && releaseId != null
            ? file.fileId === String(releaseId) : null });
      }
    }
    return matches;
  };
}

export function createTargetComparison(info, target) {
  const compareLock = lockComparison(info.lock);
  const byPath = new Map();
  const localJarsByHash = new Map();
  const prefix = target.path + '/';
  for (const mapping of info.mapping) {
    const entry = {
      source: mapping.source, destination: mapping.destination, projectPath: prefix + mapping.source,
      side: mapping.side, sha256: info.hashes[mapping.source],
    };
    const destination = mapping.destination.toLowerCase();
    append(byPath, destination, entry);
    if (isTargetMod(destination, info.config)) {
      append(localJarsByHash, entry.sha256, entry);
    }
  }
  const directories = [];
  const sourceFiles = new Set(info.source);
  for (const [side, field] of Object.entries(overrideRules)) {
    for (const rule of info.config[field] ?? []) {
      if (!sourceFiles.has(rule)) directories.push({ side, rule });
    }
  }

  function recommendations(item, mappings, lockMatches, releases) {
    if (mappings.length) {
      return mappings.map(({ projectPath, side, state, matchedBy }) => {
        let reason = '此侧别已映射到该源文件。请审查差异，并选择确实要修改的侧别。';
        if (matchedBy === 'sha256') reason = '此侧别已用另一个文件名分发相同的 JAR，可复用已有源文件。';
        else if (state === 'same') reason = '与此侧别的正式文件内容相同。';
        return { projectPath, side, reason };
      });
    }
    if (item.kind === 'mod') {
      if (lockMatches.length || platforms.some(platform => releases[platform]?.status === 'exact')) {
        return [{ projectPath: prefix + 'pakku-lock.json', side: null,
          reason: lockMatches.some(match => match.matchedBy !== 'project-id') ? 'Pakku 已锁定相同文件。' :
            '由 Pakku 在 Target 副本中生成依赖差异，审查具体版本、侧别和连带依赖。' }];
      }
      return [{ projectPath: null, side: null, reason: '待确认发布来源。若为本地 Mod，需先确定分发许可和侧别。' }];
    }
    if (item.path.startsWith('saves/')) {
      return [{ projectPath: null, side: null, reason: '这是存档内的数据包。需由维护者确定 Target 的全局数据包加载位置。' }];
    }
    const declared = directories.filter(({ rule }) => item.path.startsWith(rule + '/'));
    if (declared.length) {
      return declared.map(({ side, rule }) => ({ projectPath: prefix + item.path, side,
        reason: `Pakku 已声明 ${rule}/ 为此侧别的覆盖目录。` }));
    }
    if (item.kind === 'config' || item.kind === 'datapack') {
      const reason = item.kind === 'config' ? 'Target 未声明此配置目录，需先确认配置归属和分发侧别。' :
        '需确认 Target 如何加载全局数据包，再选择分发位置。';
      return [{ projectPath: null, side: null, reason }];
    }
    const client = ['resourcepack', 'shaderpack'].includes(item.kind) || item.path.startsWith('kubejs/client_scripts/');
    const side = client ? 'client' : 'common';
    const folder = client ? 'client-overrides' : 'overrides';
    return [{ projectPath: prefix + '.pakku/' + folder + '/' + item.path, side,
      reason: client ? '建议随客户端分发，并保留原游戏相对路径。' : '建议随两端分发，使单人游戏与独立服务器都能加载这份内容。' }];
  }

  return function comparisonFor(item, releases = {}) {
    const gamePath = item.path.toLowerCase();
    const candidates = new Set(byPath.get(gamePath));
    if (item.kind === 'mod') {
      for (const entry of localJarsByHash.get(item.sha256) ?? []) candidates.add(entry);
    }
    const mappings = Array.from(candidates, mapping => ({
      ...mapping, state: item.sha256 === mapping.sha256 ? 'same' : 'different',
      matchedBy: mapping.destination.toLowerCase() === gamePath ? 'path' : 'sha256',
    }));
    const lockMatches = item.kind === 'mod' ? compareLock(item, releases) : [];
    const states = new Set(mappings.map(mapping => mapping.state));
    let status = states.size > 1 ? 'mixed' : mappings[0]?.state ?? 'unmapped';
    if (lockMatches.length) status = lockMatches[0].matchedBy === 'project-id' ? 'possible-replacement' : 'locked';
    return { status, mappings, lockMatches, recommendations: recommendations(item, mappings, lockMatches, releases) };
  };
}
